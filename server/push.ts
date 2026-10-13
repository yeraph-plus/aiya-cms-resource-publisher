import {
    getPost,
    getSettings,
    getTermRefs,
    listDirtyPosts,
    logEvent,
    setTermRefs,
    updatePostRow,
    upsertAuthor,
    type PostRow,
    type Snapshot,
} from "./db.js";
import {
    createResource,
    parseSlugFromLink,
    updateResource,
    WpError,
    type WpItem,
} from "./wp.js";
import { buildPayload } from "./payload.js";
import { mergeRemoteFileserve, normalizeConfig, productionConfig } from "../shared/fileserve.js";
import { setProgress } from "./progress.js";

/** Consecutive transport-level failures (status 0) before the run aborts. */
const TRANSPORT_ABORT_LIMIT = 3;

export interface PushError {
    localId: number;
    title: string;
    message: string;
}

export interface PushOutcome {
    ok: boolean;
    error: string | null;
    pushed: number;
    failed: number;
    errors: PushError[];
}

function message(error: unknown): string {
    if (error instanceof WpError) {
        return `HTTP ${error.status}：${error.message}`;
    }
    return String(error);
}

function now(): string {
    return new Date().toISOString();
}

/** Order-independent identity of a row's term references. */
function refsKey(refs: Record<string, string[]>): string {
    return Object.entries(refs)
        .map(([taxonomy, list]) => `${taxonomy}:${[...list].sort().join(",")}`)
        .sort()
        .join("|");
}

/** True when the row on disk still holds exactly what was pushed. */
function unchangedSinceRead(row: PostRow, pushedRefs: Record<string, string[]>): boolean {
    const current = getPost(row.localId);
    if (!current) {
        return false;
    }
    return (
        current.status === row.status &&
        current.title === row.title &&
        current.content === row.content &&
        current.authorId === row.authorId &&
        current.dateLocal === row.dateLocal &&
        current.fileserve === row.fileserve &&
        refsKey(getTermRefs(row.localId)) === refsKey(pushedRefs)
    );
}

/**
 * Writes the site's answer back onto the row.
 *
 * A push holds its row snapshot across the network call, which can take up to
 * half a minute — long enough for the user to keep editing that row. Blanket
 * write-back would then overwrite the newer local text with the pre-push
 * snapshot and clear `dirty`, so the edit was neither saved nor ever pushed
 * again. The site-confirmed facts (post id, slug, modified stamp, snapshot)
 * always land, because they describe the site; the editable content is only
 * taken from the response while the row still holds the pushed revision.
 * Otherwise the row stays dirty and the next push carries the newer text.
 */
function applyResponse(row: PostRow, item: WpItem, pushedRefs: Record<string, string[]>): void {
    upsertAuthor(item.authorId, item.authorName);
    const termRefs: Record<string, string[]> = {};
    for (const [taxonomy, terms] of Object.entries(item.terms ?? {})) {
        termRefs[taxonomy] = terms.map((term) => String(term.id));
    }

    const state: Snapshot = {
        status: item.status,
        title: item.title,
        content: item.content,
        authorId: item.authorId,
        dateLocal: item.date,
        dateGmt: item.dateGmt,
        modifiedGmt: item.modifiedGmt,
        terms: termRefs,
        fileserve: item.fileserve,
    };

    const editedSinceRead = !unchangedSinceRead(row, pushedRefs);
    updatePostRow(row.localId, {
        postId: item.id,
        dateGmt: state.dateGmt,
        modifiedGmt: state.modifiedGmt,
        slug: parseSlugFromLink(item.link),
        snapshot: JSON.stringify(state),
        missing: false,
        conflict: false,
        lastError: null,
        lastPushedGmt: now(),
        lastSyncedGmt: now(),
        dirty: editedSinceRead,
        ...(editedSinceRead
            ? {}
            : {
                  status: state.status,
                  title: state.title,
                  content: state.content,
                  authorId: state.authorId,
                  dateLocal: state.dateLocal,
                  // The site confirms the production subset; the local netdisk
                  // fields are re-attached so the pipelines keep their ownership.
                  fileserve: mergeRemoteFileserve(item.fileserve, row.fileserve),
              }),
    });
    if (editedSinceRead) {
        logEvent(
            "info",
            "推送",
            `#${item.id} ${row.title}：推送期间本地又有编辑，站点回执没有覆盖本地内容，该行仍待推送`,
            item.id,
        );
        return;
    }
    setTermRefs(row.localId, termRefs);
}

/**
 * Push every dirty row (or the given subset): create rows without a post id,
 * update the rest. The whole per-row write — payload build, site call,
 * response application — sits in one try, so a poison row costs itself and
 * never the run. Transport-level deaths (status 0: unreachable, dead proxy)
 * are the exception: they hit every remaining row identically, so three in a
 * row abort the run before the queue burns 30 seconds per row on a dead
 * site. A 4xx proves the pipe works and resets the count — validation
 * failures deserve their per-row tries.
 */
export async function runPush(localIds?: number[]): Promise<PushOutcome> {
    const outcome: PushOutcome = { ok: false, error: null, pushed: 0, failed: 0, errors: [] };
    const settings = getSettings();
    if (!settings.siteUrl || !settings.username || !settings.appPassword) {
        outcome.error = "先在设置里填好站点地址、用户名和应用密码。";
        return outcome;
    }

    const rows = listDirtyPosts(localIds);
    if (rows.length === 0) {
        outcome.ok = true;
        return outcome;
    }
    logEvent("info", "推送", `推送开始：${rows.length} 行`);

    let transportFailures = 0;
    for (const [index, row] of rows.entries()) {
        setProgress({ phase: `推送：${row.title.slice(0, 16) || `#${row.localId}`}`, done: index, total: rows.length });
        const { config, errors } = normalizeConfig(row.fileserve ?? null);
        if (errors.length > 0) {
            outcome.failed += 1;
            outcome.errors.push({ localId: row.localId, title: row.title, message: errors.join(" ") });
            updatePostRow(row.localId, { lastError: errors.join(" ") });
            logEvent("error", "推送", `#${row.postId ?? "新行"} ${row.title}：${errors.join(" ")}`, row.postId ?? undefined);
            continue;
        }

        // The payload carries only groups with links; empty-link groups stay
        // local (the lane's pending work), and the local netdisk field is
        // stripped (the site drops it anyway).
        let fileserveValue: string | null = row.fileserve;
        if (row.fileserve !== null) {
            fileserveValue = JSON.stringify(productionConfig(config));
        }
        try {
            // Read once and hand the same references to the write-back: they
            // are what "the pushed revision" means for the race check above.
            const termRefs = getTermRefs(row.localId);
            const payload = buildPayload({ ...row, fileserve: fileserveValue }, termRefs);
            const item = row.postId
                ? await updateResource(
                      { siteUrl: settings.siteUrl, username: settings.username, appPassword: settings.appPassword, proxyUrl: settings.proxyUrl },
                      row.postId,
                      payload,
                  )
                : await createResource(
                      { siteUrl: settings.siteUrl, username: settings.username, appPassword: settings.appPassword, proxyUrl: settings.proxyUrl },
                      payload,
                  );
            applyResponse(row, item, termRefs);
            outcome.pushed += 1;
            transportFailures = 0;
            logEvent("info", "推送", `#${item.id} ${row.title}：已写入站点`, item.id);
        } catch (error) {
            const text = message(error);
            updatePostRow(row.localId, { lastError: text });
            outcome.errors.push({ localId: row.localId, title: row.title, message: text });
            outcome.failed += 1;
            logEvent("error", "推送", `#${row.postId ?? "新行"} ${row.title}：${text}`, row.postId ?? undefined);
            if (error instanceof WpError && error.status === 0) {
                transportFailures += 1;
                if (transportFailures >= TRANSPORT_ABORT_LIMIT) {
                    const remaining = rows.length - index - 1;
                    outcome.error =
                        `站点连续 ${transportFailures} 次不可达，已中止本轮推送` +
                        (remaining > 0 ? `：剩余 ${remaining} 行保持待推送。` : "。");
                    break;
                }
            } else {
                transportFailures = 0;
            }
        }
    }

    outcome.ok = outcome.failed === 0;
    if (outcome.error !== null) {
        logEvent("error", "推送", outcome.error);
    } else {
        logEvent("info", "推送", `推送结束：成功 ${outcome.pushed}，失败 ${outcome.failed}`);
    }
    return outcome;
}

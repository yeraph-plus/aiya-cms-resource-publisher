import {
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
import { normalizeConfig } from "../shared/fileserve.js";
import { configDigest } from "./digest.js";
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

function applyResponse(row: PostRow, item: WpItem): void {
    upsertAuthor(item.authorId, item.authorName);
    const remoteFileserve = item.fileserve ? JSON.stringify(item.fileserve) : null;
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

    updatePostRow(row.localId, {
        postId: item.id,
        status: state.status,
        title: state.title,
        content: state.content,
        authorId: state.authorId,
        dateLocal: state.dateLocal,
        dateGmt: state.dateGmt,
        modifiedGmt: state.modifiedGmt,
        fileserve: remoteFileserve,
        slug: parseSlugFromLink(item.link),
        // A successful whole-row write re-confirms the file list, so the
        // completion baseline moves with it.
        fileservePushedDigest: item.fileserve ? configDigest(item.fileserve) : null,
        dirty: false,
        conflict: false,
        missing: false,
        lastError: null,
        lastPushedGmt: now(),
        lastSyncedGmt: now(),
        snapshot: JSON.stringify(state),
    });
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

        const fileserve = Object.keys(config).length > 0 ? JSON.stringify(config) : row.fileserve;
        try {
            const payload = buildPayload({ ...row, fileserve }, getTermRefs(row.localId));
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
            applyResponse(row, item);
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

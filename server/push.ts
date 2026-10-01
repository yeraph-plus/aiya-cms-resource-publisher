import {
    getSettings,
    getTermRefs,
    listDirtyPosts,
    setTermRefs,
    updatePostRow,
    upsertAuthor,
    type PostRow,
    type Snapshot,
} from "./db.js";
import {
    createResource,
    updateResource,
    WpError,
    type WpItem,
} from "./wp.js";
import { buildPayload } from "./payload.js";
import { normalizeConfig } from "../shared/fileserve.js";
import { setProgress } from "./progress.js";

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
 * update the rest. A failed row records the error and the run continues.
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

    for (const [index, row] of rows.entries()) {
        setProgress({ phase: `推送：${row.title.slice(0, 16) || `#${row.localId}`}`, done: index, total: rows.length });
        const { config, errors } = normalizeConfig(row.fileserve ?? null);
        if (errors.length > 0) {
            outcome.failed += 1;
            outcome.errors.push({ localId: row.localId, title: row.title, message: errors.join(" ") });
            updatePostRow(row.localId, { lastError: errors.join(" ") });
            continue;
        }

        const fileserve = Object.keys(config).length > 0 ? JSON.stringify(config) : row.fileserve;
        const payload = buildPayload({ ...row, fileserve }, getTermRefs(row.localId));
        try {
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
        } catch (error) {
            const text = message(error);
            updatePostRow(row.localId, { lastError: text });
            outcome.errors.push({ localId: row.localId, title: row.title, message: text });
            outcome.failed += 1;
        }
    }

    outcome.ok = outcome.failed === 0;
    return outcome;
}

/**
 * The completion push: rows whose file list differs from what the site last
 * confirmed get a fileserve-only PUT. The list itself is the row's real
 * `aiya_core_fileserve` config — no separate carrier — and the "nothing new"
 * yardstick is a digest of the site-confirmed shape stored on the row.
 * The response lands through a scoped write-back — fileserve, the modified
 * stamp and the matching snapshot fields only — so a dirty row keeps its
 * in-flight edits elsewhere and its place in the push queue.
 */

import { fieldLabel, groupMissingField, normalizeConfig, type FileServeConfig } from "../shared/fileserve.js";
import { configDigest } from "./digest.js";
import { getSettings, listPosts, logEvent, parseSnapshot, updatePostRow, type PostRow } from "./db.js";
import { setProgress } from "./progress.js";
import { updateResourceFileserve, WpError, type WpItem } from "./wp.js";

/** Mirrors push.ts: three consecutive transport deaths abort the run. */
const TRANSPORT_ABORT_LIMIT = 3;

export interface CompletionError {
    localId: number;
    postId: number | null;
    title: string;
    message: string;
}

export interface CompletionOutcome {
    ok: boolean;
    error: string | null;
    pushed: number;
    failed: number;
    errors: CompletionError[];
}

/** The row's completion state, recomputed wherever the UI shows it. */
export interface CompletionState {
    /** none = no file list; incomplete = a group misses its required field;
     * ready = complete and not yet confirmed by the site; pushed = matches
     * the site-confirmed digest. */
    status: "none" | "incomplete" | "ready" | "pushed";
    /** "组 #1 · 链接" style pointers for the incomplete groups. */
    missing: string[];
}

export function completionState(row: PostRow): CompletionState {
    const { config, errors } = normalizeConfig(row.fileserve);
    if (errors.length > 0 || Object.keys(config).length === 0) {
        return { status: "none", missing: [] };
    }
    const missing: string[] = [];
    for (const [id, group] of Object.entries(config)) {
        const field = groupMissingField(group);
        if (field !== null) {
            missing.push(`组 #${id} · ${fieldLabel(field)}`);
        }
    }
    if (missing.length > 0) {
        return { status: "incomplete", missing };
    }
    if (row.fileservePushedDigest !== null && row.fileservePushedDigest === configDigest(config)) {
        return { status: "pushed", missing: [] };
    }
    return { status: "ready", missing: [] };
}

function applyCompletionResponse(row: PostRow, item: WpItem): void {
    const snapshot = parseSnapshot(row.snapshot);
    const nextSnapshot = snapshot ? { ...snapshot, modifiedGmt: item.modifiedGmt, fileserve: item.fileserve } : null;
    updatePostRow(row.localId, {
        fileserve: item.fileserve ? JSON.stringify(item.fileserve) : null,
        // The baseline rides on the server-confirmed shape, not on what we
        // sent — immune to any drift between the two normalizers.
        fileservePushedDigest: item.fileserve ? configDigest(item.fileserve) : null,
        modifiedGmt: item.modifiedGmt,
        // A clean row adopts the bumped publish moment; a dirty row keeps
        // its own date edit untouched.
        ...(row.dirty ? {} : { dateLocal: item.date, dateGmt: item.dateGmt }),
        lastError: null,
        ...(nextSnapshot ? { snapshot: JSON.stringify(nextSnapshot) } : {}),
    });
}

export async function runCompletionPush(localIds?: number[]): Promise<CompletionOutcome> {
    const outcome: CompletionOutcome = { ok: false, error: null, pushed: 0, failed: 0, errors: [] };
    const settings = getSettings();
    if (!settings.siteUrl || !settings.username || !settings.appPassword) {
        outcome.error = "先在设置里填好站点地址、用户名和应用密码。";
        return outcome;
    }

    const wanted = localIds && localIds.length > 0 ? new Set(localIds) : null;
    const candidates = listPosts().filter((row) => {
        if (row.postId === null || row.fileserve === null) {
            return false;
        }
        if (wanted !== null && !wanted.has(row.localId)) {
            return false;
        }
        // A broken blob stays a candidate so the loop reports it properly; an
        // empty config is the whole-row push's "clear the list" payload, not
        // a completion candidate; an unchanged complete list is not worth a
        // site call.
        const { config, errors } = normalizeConfig(row.fileserve);
        if (errors.length > 0) {
            return true;
        }
        if (Object.keys(config).length === 0) {
            return false;
        }
        return row.fileservePushedDigest !== configDigest(config);
    });
    if (candidates.length === 0) {
        outcome.ok = true;
        return outcome;
    }
    logEvent("info", "补完", `补完推送开始：${candidates.length} 行`);

    let transportFailures = 0;
    for (const [index, row] of candidates.entries()) {
        setProgress({ phase: `补完推送：${row.title.slice(0, 16) || `#${row.localId}`}`, done: index, total: candidates.length });
        const { config, errors } = normalizeConfig(row.fileserve);
        if (errors.length > 0) {
            outcome.failed += 1;
            outcome.errors.push({ localId: row.localId, postId: row.postId, title: row.title, message: errors.join(" ") });
            updatePostRow(row.localId, { lastError: errors.join(" ") });
            logEvent("error", "补完", `#${row.postId} ${row.title}：${errors.join(" ")}`, row.postId ?? undefined);
            continue;
        }

        // Readiness gate: every group's required field must carry a value.
        // A half-filled group would publish a dead download entry, so the
        // whole row is refused and the missing fields are named.
        const missing = Object.entries(config)
            .map(([id, group]) => ({ id, field: groupMissingField(group) }))
            .filter((entry) => entry.field !== null);
        if (missing.length > 0) {
            const text = `还有组没填完：${missing.map((entry) => `组 #${entry.id} 的「${fieldLabel(entry.field!)}」`).join("、")}`;
            outcome.failed += 1;
            outcome.errors.push({ localId: row.localId, postId: row.postId, title: row.title, message: text });
            updatePostRow(row.localId, { lastError: text });
            logEvent("warn", "补完", `#${row.postId} ${row.title}：${text}`, row.postId ?? undefined);
            continue;
        }

        try {
            const item = await updateResourceFileserve(
                {
                    siteUrl: settings.siteUrl,
                    username: settings.username,
                    appPassword: settings.appPassword,
                    proxyUrl: settings.proxyUrl,
                },
                row.postId!,
                config as FileServeConfig,
            );
            applyCompletionResponse(row, item);
            outcome.pushed += 1;
            transportFailures = 0;
            logEvent("info", "补完", `#${item.id} ${row.title}：文件列表已推送`, item.id);
        } catch (error) {
            const text = error instanceof WpError ? `HTTP ${error.status}：${error.message}` : String(error);
            updatePostRow(row.localId, { lastError: text });
            outcome.errors.push({ localId: row.localId, postId: row.postId, title: row.title, message: text });
            outcome.failed += 1;
            logEvent("error", "补完", `#${row.postId} ${row.title}：${text}`, row.postId ?? undefined);
            if (error instanceof WpError && error.status === 0) {
                transportFailures += 1;
                if (transportFailures >= TRANSPORT_ABORT_LIMIT) {
                    const remaining = candidates.length - index - 1;
                    outcome.error =
                        `站点连续 ${transportFailures} 次不可达，已中止本轮补完推送` +
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
        logEvent("error", "补完", outcome.error);
    } else {
        logEvent("info", "补完", `补完推送结束：成功 ${outcome.pushed}，失败 ${outcome.failed}`);
    }
    return outcome;
}

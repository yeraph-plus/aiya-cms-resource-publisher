/**
 * The completion push: carriers whose compiled config grew since the last
 * push get their fileserve written to the site with a fileserve-only PUT.
 * The response lands through a scoped write-back — fileserve, the modified
 * stamp and the matching snapshot fields only — so a dirty row keeps its
 * in-flight edits elsewhere and its place in the push queue.
 */

import { compileConfig, listSinks, markCarrierPushed } from "./carrier.js";
import { normalizeConfig } from "../shared/fileserve.js";
import { getPost, getSettings, parseSnapshot, updatePostRow, type PostRow } from "./db.js";
import { setProgress } from "./progress.js";
import { updateResourceFileserve, WpError, type WpItem } from "./wp.js";

/** Mirrors push.ts: three consecutive transport deaths abort the run. */
const TRANSPORT_ABORT_LIMIT = 3;

export interface CompletionError {
    dirName: string;
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

function applyCompletionResponse(row: PostRow, item: WpItem): void {
    const snapshot = parseSnapshot(row.snapshot);
    const nextSnapshot = snapshot ? { ...snapshot, modifiedGmt: item.modifiedGmt, fileserve: item.fileserve } : null;
    updatePostRow(row.localId, {
        fileserve: item.fileserve ? JSON.stringify(item.fileserve) : null,
        modifiedGmt: item.modifiedGmt,
        // A clean row adopts the bumped publish moment; a dirty row keeps
        // its own date edit untouched.
        ...(row.dirty ? {} : { dateLocal: item.date, dateGmt: item.dateGmt }),
        lastError: null,
        ...(nextSnapshot ? { snapshot: JSON.stringify(nextSnapshot) } : {}),
    });
}

export async function runCompletionPush(dirNames?: string[]): Promise<CompletionOutcome> {
    const outcome: CompletionOutcome = { ok: false, error: null, pushed: 0, failed: 0, errors: [] };
    const settings = getSettings();
    if (!settings.siteUrl || !settings.username || !settings.appPassword) {
        outcome.error = "先在设置里填好站点地址、用户名和应用密码。";
        return outcome;
    }
    const workRoot = settings.workRoot.trim();
    if (workRoot === "") {
        outcome.error = "先在设置里填好补完工作目录。";
        return outcome;
    }

    const wanted = dirNames && dirNames.length > 0 ? new Set(dirNames) : null;
    const candidates = listSinks(workRoot).filter(
        (sink) => sink.status === "ready" && sink.carrier !== null && (wanted === null || wanted.has(sink.dirName)),
    );

    let transportFailures = 0;
    for (const [index, sink] of candidates.entries()) {
        const carrier = sink.carrier!;
        setProgress({ phase: `补完推送：${carrier.dirName}`, done: index, total: candidates.length });
        const row = getPost(carrier.localId);
        if (!row || row.postId === null) {
            outcome.failed += 1;
            outcome.errors.push({ dirName: carrier.dirName, title: `#${carrier.localId}`, message: "本地行不存在，无法回写。" });
            continue;
        }
        if (row.postId !== carrier.postId) {
            outcome.failed += 1;
            outcome.errors.push({
                dirName: carrier.dirName,
                title: row.title,
                message: `载体记录的帖子（#${carrier.postId}）与本地行（#${row.postId}）不一致。`,
            });
            continue;
        }
        const compiled = compileConfig(carrier);
        const { config, errors } = normalizeConfig(compiled);
        if (errors.length > 0) {
            outcome.failed += 1;
            outcome.errors.push({ dirName: carrier.dirName, title: row.title, message: errors.join(" ") });
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
                row.postId,
                config,
            );
            applyCompletionResponse(row, item);
            // The digest rides on the compiled form — the canonical shape
            // carrierStatus recomputes — while `config` is the normalized
            // variant the site call actually carried.
            markCarrierPushed(sink.path, carrier, compiled);
            outcome.pushed += 1;
            transportFailures = 0;
        } catch (error) {
            const text = error instanceof WpError ? `HTTP ${error.status}：${error.message}` : String(error);
            updatePostRow(row.localId, { lastError: text });
            outcome.errors.push({ dirName: carrier.dirName, title: row.title, message: text });
            outcome.failed += 1;
            if (error instanceof WpError && error.status === 0) {
                transportFailures += 1;
                if (transportFailures >= TRANSPORT_ABORT_LIMIT) {
                    const remaining = candidates.length - index - 1;
                    outcome.error =
                        `站点连续 ${transportFailures} 次不可达，已中止本轮补完推送` +
                        (remaining > 0 ? `：剩余 ${remaining} 个骨架保持待推送。` : "。");
                    break;
                }
            } else {
                transportFailures = 0;
            }
        }
    }

    outcome.ok = outcome.failed === 0;
    return outcome;
}

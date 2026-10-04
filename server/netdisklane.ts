/**
 * The netdisk share lane: a userscript running on pan.baidu.com locates the
 * staging-named folder the user uploaded via the netdisk client, creates the
 * share in-page, and posts url+code back here. Queue items are the row's
 * platform groups with an empty link; a result fills the group and flags it
 * for push. No new tables, no new settings — the queue is derived and the
 * write-back rides the existing row semantics.
 */

import { normalizeConfig, priceDefault } from "../shared/fileserve.js";
import { getPost, listPosts, logEvent, updatePostRow, type PostRow } from "./db.js";
import { stagingDirName } from "./dirs.js";

export interface QueueItem {
    localId: number;
    postId: number;
    groupId: string;
    /** The staging-named folder to locate in the netdisk (00501-标题). */
    dirName: string;
    title: string;
    groupTitle: string;
    price: number;
}

export function buildQueue(): QueueItem[] {
    const queue: QueueItem[] = [];
    for (const row of listPosts()) {
        if (row.postId === null || row.fileserve === null) {
            continue;
        }
        const { config, errors } = normalizeConfig(row.fileserve);
        if (errors.length > 0) {
            continue;
        }
        for (const [id, group] of Object.entries(config)) {
            if (group.adapter !== "platform") {
                continue;
            }
            if (typeof group.url === "string" && group.url.trim() !== "") {
                continue;
            }
            queue.push({
                localId: row.localId,
                postId: row.postId,
                groupId: id,
                dirName: stagingDirName(row.postId, row.title),
                title: row.title,
                groupTitle: typeof group.title === "string" && group.title !== "" ? group.title : "网盘链接",
                price: typeof group.price === "number" ? group.price : priceDefault("platform"),
            });
        }
    }
    return queue;
}

export type ApplyResultOutcome =
    | { ok: true; row: PostRow }
    | { ok: false; error: string };

/**
 * Fill one group's share link, flag it for push, and mark the row dirty.
 * Refusing already-filled groups keeps a replayed request from clobbering a
 * newer link with a stale one.
 */
export function applyResult(localId: number, groupId: string, url: string, code: string): ApplyResultOutcome {
    const trimmedUrl = url.trim();
    if (trimmedUrl === "") {
        return { ok: false, error: "分享链接为空。" };
    }
    const row = getPost(localId);
    if (!row) {
        return { ok: false, error: "本地行不存在。" };
    }
    if (row.fileserve === null) {
        return { ok: false, error: "这一行还没有文件列表。" };
    }
    const { config, errors } = normalizeConfig(row.fileserve);
    if (errors.length > 0) {
        return { ok: false, error: errors.join(" ") };
    }
    const group = config[groupId];
    if (!group) {
        return { ok: false, error: `组 #${groupId} 不存在。` };
    }
    if (group.adapter !== "platform") {
        return { ok: false, error: `组 #${groupId} 不是网盘链接组。` };
    }
    if (typeof group.url === "string" && group.url.trim() !== "") {
        return { ok: false, error: `组 #${groupId} 已有分享链接，拒绝覆盖；如需重取请先清空该组链接。` };
    }
    group.url = trimmedUrl;
    group.code = code.trim();
    group.push = true;
    updatePostRow(localId, {
        fileserve: JSON.stringify(config),
        dirty: true,
    });
    logEvent("info", "网盘", `#${row.postId} ${row.title}：组 #${groupId} 分享已回填并勾选推送`, row.postId ?? undefined);
    return { ok: true, row: getPost(localId)! };
}

/**
 * The netdisk share lane: a userscript running on pan.baidu.com locates the
 * staging-named folder the user uploaded via the netdisk client, creates the
 * share in-page, and posts url+code back here. Queue items are the row's
 * platform groups with an empty link; a result fills the group and flags it
 * for push. No new tables, no new settings — the queue is derived and the
 * write-back rides the existing row semantics.
 */

import { normalizeConfig, groupNetdisk, netdiskLabel, priceDefault } from "../shared/fileserve.js";
import { coerceDirNameSuffix, stagingDirName } from "../shared/staging-name.js";
import { getPost, getSettings, listPosts, logEvent, updatePostRow, type PostRow } from "./db.js";

// --- 网盘目录命名 -----------------------------------------------------------
// Folder names come from shared/staging-name.ts (post id padded + sanitized
// title); the lane derives them from the row and never reads the local
// staging helper.

export interface QueueItem {
    localId: number;
    postId: number;
    groupId: string;
    netdisk: string;
    /** The staged folder's name in the netdisk (00501-标题). */
    dirName: string;
    title: string;
    groupTitle: string;
    price: number;
}

/** The queue for one pipeline: its own empty-link platform groups. The
 * netdisk field decides ownership — a baidu script never sees a quark
 * group, so pipelines cannot clobber each other. Groups predating the
 * field default to baidu. */
export function buildQueue(netdisk: string): QueueItem[] {
    const suffix = coerceDirNameSuffix(getSettings().dirNameSuffix);
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
            const owner = groupNetdisk(group);
            if (group.adapter !== "platform" || owner !== netdisk) {
                continue;
            }
            if (typeof group.url === "string" && group.url.trim() !== "") {
                continue;
            }
            queue.push({
                localId: row.localId,
                postId: row.postId,
                groupId: id,
                netdisk: owner,
                dirName: stagingDirName(row.postId, {
                    title: row.title,
                    slug: row.slug,
                    suffix,
                }),
                title: row.title,
                groupTitle: typeof group.title === "string" && group.title !== "" ? group.title : netdiskLabel(owner),
                price: typeof group.price === "number" ? group.price : priceDefault("platform"),
            });
        }
    }
    return queue;
}

export type ApplyResultOutcome =
    | { ok: true; row: PostRow }
    | { ok: false; error: string };

// --- 回填通知 ---------------------------------------------------------------
// The script writes the file list straight into the database, so a client that
// is already open never hears about it: its cached row still shows the link as
// empty, its 标记 column still says 可补, and — the damaging part — the row's
// detail panel keeps a draft taken before the fill, so the next save of *any*
// field would put that empty draft back and destroy the link. Every applied
// result therefore lands in a small in-memory ring that an open client polls.
// The sequence restarts with the process, which costs nothing: a client that
// starts later reads the whole state anyway.

const APPLIED_KEEP = 200;
let appliedSeq = 0;
const appliedRing: { seq: number; localId: number }[] = [];

export function noteApplied(localId: number): void {
    appliedSeq += 1;
    appliedRing.push({ seq: appliedSeq, localId });
    if (appliedRing.length > APPLIED_KEEP) {
        appliedRing.splice(0, appliedRing.length - APPLIED_KEEP);
    }
}

export interface AppliedResults {
    cursor: number;
    localIds: number[];
}

/**
 * The rows filled since `after`. The cursor is the ring's high-water mark
 * rather than the newest id actually returned: a caller further behind than
 * the ring must not be fed rows the ring already dropped, and must not be left
 * stuck just below the mark on every poll.
 */
export function appliedSince(after: number): AppliedResults {
    const entries = appliedRing.filter((entry) => entry.seq > after);
    return {
        cursor: appliedSeq,
        localIds: [...new Set(entries.map((entry) => entry.localId))],
    };
}

/**
 * Fill one group's share link and mark the row dirty. The group's netdisk
 * field must match the calling pipeline (an untagged group counts as baidu),
 * and an already-filled group refuses the write so a replayed request cannot
 * clobber a newer link with a stale one.
 */
export function applyResult(netdisk: string, localId: number, groupId: string, url: string, code: string): ApplyResultOutcome {
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
    const owner = groupNetdisk(group);
    if (owner !== netdisk) {
        return { ok: false, error: `组 #${groupId} 属于 ${netdiskLabel(owner)} 管线，${netdiskLabel(netdisk)} 脚本不能回填。` };
    }
    if (typeof group.url === "string" && group.url.trim() !== "") {
        return { ok: false, error: `组 #${groupId} 已有分享链接，拒绝覆盖；如需重取请先清空该组链接。` };
    }
    group.url = trimmedUrl;
    group.code = code.trim();
    // A group title must never be empty: default it from the netdisk.
    if (typeof group.title !== "string" || group.title.trim() === "") {
        group.title = netdiskLabel(owner);
    }
    updatePostRow(localId, {
        fileserve: JSON.stringify(config),
        dirty: true,
    });
    noteApplied(localId);
    logEvent("info", "网盘", `#${row.postId} ${row.title}：组 #${groupId}（${netdiskLabel(owner)}）分享已回填`, row.postId ?? undefined);
    return { ok: true, row: getPost(localId)! };
}

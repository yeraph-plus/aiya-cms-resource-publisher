/**
 * File-list work state per row — the grid badge's ground truth. The badge
 * speaks the lane's language: what the netdisk pipelines can fill right now.
 * Push timing is the row's own dirty flag and has no per-list badge.
 */

import { normalizeConfig, groupNetdisk, netdiskLabel } from "../shared/fileserve.js";
import type { PostRow } from "./db.js";

export interface FileServeState {
    /** unmounted = the row carries no file list; fillable = platform groups
     * with empty links exist and the matching pipeline can fill them;
     * complete = every group carries its link. */
    status: "unmounted" | "fillable" | "complete";
    /** The fillable groups, e.g. [{groupId: "2", label: "百度网盘"}]. */
    items: { groupId: string; label: string }[];
}

export function fileServeState(row: PostRow): FileServeState {
    if (row.fileserve === null) {
        return { status: "unmounted", items: [] };
    }
    const { config, errors } = normalizeConfig(row.fileserve);
    if (errors.length > 0 || Object.keys(config).length === 0) {
        return { status: "unmounted", items: [] };
    }
    const items = Object.entries(config)
        .filter(([, group]) => group.adapter === "platform")
        .filter(([, group]) => typeof group.url !== "string" || group.url.trim() === "")
        .map(([groupId, group]) => ({ groupId, label: netdiskLabel(groupNetdisk(group)) }));
    return items.length > 0 ? { status: "fillable", items } : { status: "complete", items: [] };
}

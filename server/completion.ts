/**
 * File-list push state per row — the grid badge's ground truth. There is no
 * separate push lane any more: the whole-row push carries the flagged groups
 * (per-group 推送 switches), and the digest baseline says whether what would
 * go out already matches the site.
 */

import { fieldLabel, groupMissingField, normalizeConfig, pushableConfig } from "../shared/fileserve.js";
import { configDigest } from "./digest.js";
import type { PostRow } from "./db.js";

export interface CompletionState {
    /** none = no file list (or nothing flagged for the site); incomplete =
     * a flagged group misses its required field; ready = the flagged set
     * differs from the site-confirmed digest; pushed = they match. */
    status: "none" | "incomplete" | "ready" | "pushed";
    /** "组 #1 · 链接" style pointers for the incomplete groups. */
    missing: string[];
}

export function completionState(row: PostRow): CompletionState {
    if (row.fileserve === null) {
        return { status: "none", missing: [] };
    }
    const { config, errors } = normalizeConfig(row.fileserve);
    if (errors.length > 0 || Object.keys(config).length === 0) {
        return { status: "none", missing: [] };
    }
    const { config: effective, blocked } = pushableConfig(config);
    if (blocked.length > 0) {
        return {
            status: "incomplete",
            missing: blocked.map(({ id, field }) => `组 #${id} · ${fieldLabel(field)}`),
        };
    }
    if (Object.keys(effective).length === 0) {
        // Only local drafts — nothing will go out with the next push.
        return { status: "none", missing: [] };
    }
    if (row.fileservePushedDigest !== null && row.fileservePushedDigest === configDigest(effective)) {
        return { status: "pushed", missing: [] };
    }
    return { status: "ready", missing: [] };
}

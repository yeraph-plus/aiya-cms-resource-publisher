/**
 * File-list push state per row — the grid badge's ground truth. There is no
 * separate push lane any more: the whole-row push carries the flagged groups
 * (per-group 推送 switches), and the digest baseline says whether what would
 * go out already matches the site.
 */

import { fieldLabel, groupMissingField, normalizeConfig, pushableConfig } from "../shared/fileserve.js";
import { configDigest } from "./digest.js";
import type { PostRow } from "./db.js";

export interface FileServeState {
    /** none = no file list; incomplete = a flagged group misses its required
     * field; draft = groups exist but none is flagged (a push sends the empty
     * config, which clears the online list — that is why this gets its own
     * badge); ready = the flagged set differs from the site-confirmed digest;
     * pushed = they match. */
    status: "none" | "incomplete" | "draft" | "ready" | "pushed";
    /** "组 #1 · 链接" style pointers for the incomplete groups. */
    missing: string[];
}

export function fileServeState(row: PostRow): FileServeState {
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
        // Every group is a local draft: the next push sends the empty
        // production config and clears the online list.
        return { status: "draft", missing: [] };
    }
    if (row.fileservePushedDigest !== null && row.fileservePushedDigest === configDigest(effective)) {
        return { status: "pushed", missing: [] };
    }
    return { status: "ready", missing: [] };
}

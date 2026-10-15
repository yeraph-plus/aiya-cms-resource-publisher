/** Shared client-side DTOs mirroring the local server's /api/state shape. */

export interface SettingsDTO {
    siteUrl: string;
    username: string;
    hasPassword: boolean;
    proxyUrl: string;
    defaultAuthorId: number | null;
    lastSyncCursor: string | null;
    workRoot: string;
    dirNameSuffix: string;
    /** Status a row created without one gets (摄取/新建行). */
    newRowStatus: string;
    /** Attach the selected netdisk pipelines to every brand-new row. */
    netdiskTodoEnabled: boolean;
    /** Comma-joined NETDISK_OPTIONS ids. */
    netdiskTodoGroups: string;
}

export interface AuthorDTO {
    id: number;
    name: string;
    remark: string;
}

export interface TermInfo {
    id: number;
    name: string;
    slug: string;
    /** Hierarchical taxonomies (分类) only: parent term id, 0 = top level. */
    parent: number;
}

/** Server-recomputed work state of a row's file groups — the grid badge's
 * ground truth: what the netdisk pipelines can fill right now. */
export interface FileServeStateDTO {
    status: "unmounted" | "fillable" | "complete";
    items: { groupId: string; label: string }[];
}

export interface RowDTO {
    localId: number;
    postId: number | null;
    status: string;
    title: string;
    content: string;
    authorId: number | null;
    dateLocal: string;
    dateGmt: string;
    modifiedGmt: string;
    fileserve: string | null;
    dirty: boolean;
    conflict: boolean;
    missing: boolean;
    lastSyncedGmt: string | null;
    lastPushedGmt: string | null;
    lastError: string | null;
    terms: Record<string, string[]>;
    fileserveParsed: unknown;
    fileServe: FileServeStateDTO;
}

export interface StateDTO {
    settings: SettingsDTO;
    authors: AuthorDTO[];
    terms: Record<string, TermInfo[]>;
    posts: RowDTO[];
}

/** One operational log entry; ids only grow, so clients poll incrementally. */
export interface LogDTO {
    id: number;
    ts: string;
    level: "info" | "warn" | "error";
    scope: string;
    ref: number | null;
    message: string;
}

export { TAXONOMY_ORDER, TAXONOMY_LABELS } from "../shared/import";

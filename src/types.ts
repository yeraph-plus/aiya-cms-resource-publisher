/** Shared client-side DTOs mirroring the local server's /api/state shape. */

export interface SettingsDTO {
    siteUrl: string;
    username: string;
    hasPassword: boolean;
    proxyUrl: string;
    defaultAuthorId: number | null;
    lastSyncCursor: string | null;
    workRoot: string;
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
}

/** Server-recomputed push state of a row's flagged file groups — the grid
 * badge's ground truth. */
export interface FileServeStateDTO {
    status: "none" | "incomplete" | "draft" | "ready" | "pushed";
    missing: string[];
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

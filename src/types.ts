/** Shared client-side DTOs mirroring the local server's /api/state shape. */

export interface SettingsDTO {
    siteUrl: string;
    username: string;
    hasPassword: boolean;
    proxyUrl: string;
    defaultAuthorId: number | null;
    lastSyncCursor: string | null;
    workRoot: string;
    dirNameMode: string;
    fileserveTemplate: string | null;
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
}

export interface StateDTO {
    settings: SettingsDTO;
    authors: AuthorDTO[];
    terms: Record<string, TermInfo[]>;
    posts: RowDTO[];
}

/** One completion sink (文件骨架): a working directory with its carrier. */
export interface SinkDTO {
    dirName: string;
    path: string;
    status: "draft" | "ready" | "pushed" | "broken";
    error: string | null;
    carrier: {
        localId: number;
        postId: number;
        slug: string | null;
        groupsTotal: number;
        groupsReady: number;
    } | null;
}

export interface ScanSinksDTO {
    workRoot: string;
    sinks: SinkDTO[];
}

export { TAXONOMY_ORDER, TAXONOMY_LABELS } from "../shared/import";

import type { LogDTO, RowDTO, StateDTO } from "./types";

async function json<T>(response: Response): Promise<T> {
    if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${response.status}`);
    }
    return (await response.json()) as T;
}

/** Every call spells out its method — the server registers verb-specific routes. */
async function call<T>(url: string, method: "GET" | "POST" | "PUT" | "DELETE", payload?: unknown): Promise<T> {
    return json<T>(
        await fetch(url, {
            method,
            headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
            body: payload === undefined ? undefined : JSON.stringify(payload),
        }),
    );
}

export function fetchState(): Promise<StateDTO> {
    return call<StateDTO>("/api/state", "GET");
}

export interface RowPatch {
    status?: string;
    title?: string;
    content?: string;
    authorId?: number | null;
    dateLocal?: string;
    fileserve?: unknown;
    terms?: Record<string, string[]>;
}

export function saveRow(localId: number, patch: RowPatch): Promise<RowDTO> {
    return call<RowDTO>(`/api/posts/${localId}`, "PUT", patch);
}

export async function createRow(title?: string): Promise<number> {
    const body = await call<{ localId: number }>("/api/posts", "POST", { title });
    return body.localId;
}

export function deleteRow(localId: number): Promise<{ ok: boolean }> {
    return call<{ ok: boolean }>(`/api/posts/${localId}`, "DELETE");
}

export function revertRow(localId: number): Promise<{ ok: boolean }> {
    return call<{ ok: boolean }>(`/api/posts/${localId}/revert`, "POST");
}

export interface SaveSettingsPayload {
    siteUrl?: string;
    username?: string;
    appPassword?: string;
    proxyUrl?: string;
    defaultAuthorId?: number | null;
    workRoot?: string;
    dirNameSuffix?: string;
}

export function saveSettings(payload: SaveSettingsPayload): Promise<{ ok: boolean }> {
    return call<{ ok: boolean }>("/api/settings", "PUT", payload);
}

export interface ConnectPayload extends SaveSettingsPayload {
    /** The password field is only sent when the user typed one. */
}

export interface ConnectResult {
    ok: boolean;
    error?: string;
    ping?: { user: { login: string; name: string }; caps: Record<string, boolean>; version: string };
}

/** Probes the site with the typed values layered over the stored settings. */
export function connect(payload: ConnectPayload = {}): Promise<ConnectResult> {
    return call<ConnectResult>("/api/connect", "POST", payload);
}

export interface SyncOutcomeDTO {
    ok: boolean;
    error: string | null;
    fetched: number;
    created: number;
    refreshed: number;
    conflicts: number;
    missing: number;
    skipped: number;
}

export function sync(): Promise<SyncOutcomeDTO> {
    return call<SyncOutcomeDTO>("/api/sync", "POST", {});
}

export interface PushOutcomeDTO {
    ok: boolean;
    error: string | null;
    pushed: number;
    failed: number;
    errors: { localId: number; title: string; message: string }[];
}

export function push(localIds?: number[]): Promise<PushOutcomeDTO> {
    return call<PushOutcomeDTO>("/api/push", "POST", { localIds });
}

export interface ImportPreviewDTO {
    headers: string[];
    rowCount: number;
    preview: string[][];
    guess: Record<string, number | null>;
}

export function importPreview(csv: string): Promise<ImportPreviewDTO> {
    return call<ImportPreviewDTO>("/api/import/preview", "POST", { csv });
}

export interface ImportApplyPayload {
    csv: string;
    mapping: Record<string, number | null>;
    defaultStatus: string;
    defaultAuthorId: number | null;
    unmatchedAuthor: "error" | "default";
}

export interface ImportRowErrorDTO {
    row: number;
    title: string;
    error: string;
}

export interface ImportApplyResultDTO {
    imported: number;
    failed: number;
    errors: ImportRowErrorDTO[];
    localIds: number[];
}

export function importApply(payload: ImportApplyPayload): Promise<ImportApplyResultDTO> {
    return call<ImportApplyResultDTO>("/api/import/apply", "POST", payload);
}

export interface ProgressDTO {
    phase: string;
    done: number;
    total: number;
}

/** Snapshot of the running pull/push; null when the tool is idle. */
export function fetchProgress(): Promise<ProgressDTO | null> {
    return call<ProgressDTO | null>("/api/progress", "GET");
}

/** Log entries past the given id, ascending. */
export function fetchLogs(after: number, limit = 300): Promise<{ logs: LogDTO[] }> {
    return call<{ logs: LogDTO[] }>(`/api/logs?after=${after}&limit=${limit}`, "GET");
}

export function clearLogs(): Promise<{ ok: boolean; cleared: number }> {
    return call<{ ok: boolean; cleared: number }>("/api/logs/clear", "POST", {});
}

export interface StagingDirDTO {
    status: "claimed" | "created" | "blocked";
    dir: string | null;
    name: string | null;
    reason?: string;
}

/** Idempotent; answers status "blocked" (200) for expected conditions. */
export function ensureStagingDir(localId: number): Promise<StagingDirDTO> {
    return call<StagingDirDTO>("/api/fileserve-dir/ensure", "POST", { localId });
}

/** Ensures first, then opens the folder in the file manager. */
export function openStagingDir(localId: number): Promise<StagingDirDTO> {
    return call<StagingDirDTO>("/api/fileserve-dir/open", "POST", { localId });
}

export function fetchStagingDir(localId: number): Promise<{ dir: string | null; name: string | null }> {
    return call<{ dir: string | null; name: string | null }>(`/api/fileserve-dir/${localId}`, "GET");
}

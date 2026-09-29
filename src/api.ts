import type { RowDTO, StateDTO } from "./types";

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

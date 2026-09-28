import type { RowDTO, StateDTO } from "./types";

async function json<T>(response: Response): Promise<T> {
    if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${response.status}`);
    }
    return (await response.json()) as T;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
    return json<T>(await fetch(url, init));
}

function withBody(payload: unknown): RequestInit {
    return {
        method: payload === undefined ? "GET" : "POST",
        headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
    };
}

export function fetchState(): Promise<StateDTO> {
    return call<StateDTO>("/api/state");
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

export async function saveRow(localId: number, patch: RowPatch): Promise<RowDTO> {
    return json<RowDTO>(
        await fetch(`/api/posts/${localId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
        }),
    );
}

export async function createRow(title?: string): Promise<number> {
    const body = await json<{ localId: number }>(await fetch("/api/posts", withBody({ title })));
    return body.localId;
}

export async function deleteRow(localId: number): Promise<void> {
    await json<{ ok: boolean }>(await fetch(`/api/posts/${localId}`, { method: "DELETE" }));
}

export async function revertRow(localId: number): Promise<void> {
    await json<{ ok: boolean }>(await fetch(`/api/posts/${localId}/revert`, { method: "POST" }));
}

export interface SaveSettingsPayload {
    siteUrl?: string;
    username?: string;
    appPassword?: string;
    defaultAuthorId?: number | null;
}

export function saveSettings(payload: SaveSettingsPayload): Promise<{ ok: boolean }> {
    return call<{ ok: boolean }>("/api/settings", withBody(payload));
}

export interface ConnectResult {
    ok: boolean;
    error?: string;
    ping?: { user: { login: string; name: string }; caps: Record<string, boolean>; version: string };
}

export function connect(): Promise<ConnectResult> {
    return call<ConnectResult>("/api/connect", withBody({}));
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
    return call<SyncOutcomeDTO>("/api/sync", withBody({}));
}

export interface PushOutcomeDTO {
    ok: boolean;
    error: string | null;
    pushed: number;
    failed: number;
    errors: { localId: number; title: string; message: string }[];
}

export function push(localIds?: number[]): Promise<PushOutcomeDTO> {
    return call<PushOutcomeDTO>("/api/push", withBody({ localIds }));
}

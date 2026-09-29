/**
 * HTTP client for the site's aiya-publish/v1 namespace. Every call carries
 * the application password as Basic auth; failures surface as WpError with
 * the message WordPress sent. An optional HTTP proxy (from the settings)
 * applies to every outbound call via undici's ProxyAgent.
 */

import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";

export interface WpCreds {
    siteUrl: string;
    username: string;
    appPassword: string;
    proxyUrl?: string;
}

export class WpError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(status: number, code: string, message: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export interface WpTermRef {
    id: number;
    name: string;
    slug: string;
}

export interface WpItem {
    id: number;
    status: string;
    title: string;
    content: string;
    date: string;
    dateGmt: string;
    modified: string;
    modifiedGmt: string;
    link: string;
    authorId: number;
    authorName: string;
    terms: Record<string, WpTermRef[]> | null;
    fileserve: Record<string, Record<string, unknown>> | null;
}

export interface WpTaxonomy {
    slug: string;
    hierarchical: boolean;
    terms: { id: number; name: string; slug: string; count: number }[];
}

export interface WpPing {
    user: { id: number; login: string; name: string };
    caps: { editPosts: boolean; publishPosts: boolean; editOthersPosts: boolean };
    resourceAvailable: boolean;
    version: string;
}

/** Accepts "localhost:8000" and full URLs; the REST root is derived from it. */
export function normalizeSiteUrl(raw: string): string {
    let url = raw.trim();
    if (url === "") {
        return "";
    }
    if (!/^https?:\/\//i.test(url)) {
        url = `https://${url}`;
    }
    return url.replace(/\/+$/, "");
}

/** A proxy agent for the configured URL, or null when no proxy is set. */
function proxyDispatcher(proxyUrl: string | undefined): Dispatcher | null {
    const raw = (proxyUrl ?? "").trim();
    if (raw === "") {
        return null;
    }
    const parsed = new URL(raw);
    const token =
        parsed.username !== "" || parsed.password !== ""
            ? `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString("base64")}`
            : undefined;
    return new ProxyAgent({
        uri: `${parsed.protocol}//${parsed.host}`,
        token,
    });
}

async function request<T>(creds: WpCreds, method: string, path: string, payload?: unknown): Promise<T> {
    const root = `${normalizeSiteUrl(creds.siteUrl)}/wp-json/aiya-publish/v1`;
    const dispatcher = proxyDispatcher(creds.proxyUrl);
    let response: Response;
    try {
        response = await undiciFetch(root + path, {
            method,
            headers: {
                Authorization: `Basic ${Buffer.from(`${creds.username}:${creds.appPassword}`).toString("base64")}`,
                ...(payload !== undefined ? { "Content-Type": "application/json; charset=utf-8" } : {}),
            },
            body: payload !== undefined ? JSON.stringify(payload) : undefined,
            signal: AbortSignal.timeout(30_000),
            ...(dispatcher ? { dispatcher } : {}),
        }) as unknown as Response;
    } catch (error) {
        const hint = dispatcher ? `（代理 ${creds.proxyUrl}）` : "";
        throw new WpError(0, "aiya_publish_unreachable", `无法连接站点${hint}：${String(error)}`);
    }

    const text = await response.text();
    let body: unknown = null;
    try {
        body = text === "" ? null : JSON.parse(text);
    } catch {
        // Non-JSON body (proxy error page etc.)
    }

    if (!response.ok) {
        const shaped = body as { code?: string; message?: string } | null;
        throw new WpError(
            response.status,
            shaped?.code ?? "aiya_publish_http_error",
            shaped?.message ?? `HTTP ${response.status}`,
        );
    }
    return body as T;
}

export async function ping(creds: WpCreds): Promise<WpPing> {
    return request<WpPing>(creds, "GET", "/ping");
}

export async function taxonomies(creds: WpCreds): Promise<WpTaxonomy[]> {
    return request<WpTaxonomy[]>(creds, "GET", "/taxonomies");
}

export interface WpUser {
    id: number;
    login: string;
    name: string;
}

/** Every account a post can be authored by (edit_posts and up). */
export async function users(creds: WpCreds): Promise<WpUser[]> {
    return request<WpUser[]>(creds, "GET", "/users");
}

/**
 * One page of the resource list. The endpoint answers a bare array; the
 * caller pages until a short page — an exact multiple of the page size costs
 * one extra empty request, nothing more.
 */
export async function listResources(creds: WpCreds, page: number, perPage: number, modifiedAfter?: string): Promise<WpItem[]> {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("per_page", String(perPage));
    if (modifiedAfter) {
        params.set("modified_after", modifiedAfter);
    }
    return request<WpItem[]>(creds, "GET", `/resource?${params.toString()}`);
}

/** A term reference as the push payload expects: numeric id or a bare name. */
export type PushTermRef = number | string;

export interface PushPayload {
    title: string;
    content: string;
    status: string;
    authorId?: number;
    date?: string;
    dateGmt?: string;
    terms: Record<string, PushTermRef[]>;
    fileserve: unknown;
}

export async function createResource(creds: WpCreds, payload: PushPayload): Promise<WpItem> {
    return request<WpItem>(creds, "POST", "/resource", payload);
}

export async function updateResource(creds: WpCreds, postId: number, payload: PushPayload): Promise<WpItem> {
    return request<WpItem>(creds, "PUT", `/resource/${postId}`, payload);
}

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

/** One agent per proxy endpoint, reused across requests — a fresh ProxyAgent
 * per call would open a new connection pool every time and never close it. */
const proxyAgents = new Map<string, ProxyAgent>();

/**
 * A proxy agent for the configured URL, or null when no proxy is set.
 * Accepts scheme-less "127.0.0.1:10808" like the site URL does. Only HTTP(S)
 * proxies: undici's ProxyAgent cannot speak SOCKS — a socks:// URL is a
 * configuration error and answers as one.
 */
function proxyDispatcher(proxyUrl: string | undefined): Dispatcher | null {
    let raw = (proxyUrl ?? "").trim();
    if (raw === "") {
        return null;
    }
    if (!/^https?:\/\//i.test(raw)) {
        raw = `http://${raw}`;
    }
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new WpError(
            0,
            "aiya_publish_proxy_invalid",
            `代理仅支持 http(s)://，不支持 ${parsed.protocol}（SOCKS 需在代理客户端开 HTTP/mixed 端口）：${proxyUrl}`,
        );
    }
    const token =
        parsed.username !== "" || parsed.password !== ""
            ? `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString("base64")}`
            : undefined;
    const key = `${parsed.protocol}//${parsed.host}|${token ?? ""}`;
    let agent = proxyAgents.get(key);
    if (!agent) {
        agent = new ProxyAgent({ uri: `${parsed.protocol}//${parsed.host}`, token });
        proxyAgents.set(key, agent);
    }
    return agent;
}

async function request<T>(creds: WpCreds, method: string, path: string, payload?: unknown, capture?: (response: Response) => void): Promise<T> {
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
    capture?.(response);

    const text = await response.text();
    let body: unknown = null;
    try {
        body = text === "" ? null : JSON.parse(text);
    } catch {
        // Non-JSON body (proxy error page etc.)
    }

    if (!response.ok) {
        const shaped = body as { code?: string; message?: string } | null;
        // Cloudflare answers its bot challenge with an HTML page and no REST
        // error at all — name it, or the tool would show a bare "HTTP 403".
        const challenged = response.headers.get("cf-mitigated") === "challenge";
        throw new WpError(
            response.status,
            shaped?.code ?? "aiya_publish_http_error",
            shaped?.message ??
                (challenged
                    ? "Cloudflare 人机验证拦截（响应是挑战页而非站点应答）：需在 Cloudflare 为 /wp-json/ 路径配置跳过挑战的 WAF 规则。"
                    : `HTTP ${response.status}`),
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

export interface ResourcePage {
    items: WpItem[];
    /** X-WP-Total of the queried list, when the site reports it. */
    total: number | null;
}

/**
 * One page of the resource list. The endpoint answers a bare array; the
 * caller pages until a short page — an exact multiple of the page size costs
 * one extra empty request, nothing more. The X-WP-Total header feeds the
 * pull progress bar.
 */
export async function listResources(creds: WpCreds, page: number, perPage: number, modifiedAfter?: string): Promise<ResourcePage> {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("per_page", String(perPage));
    if (modifiedAfter) {
        params.set("modified_after", modifiedAfter);
    }
    const box: { total: number | null } = { total: null };
    const items = await request<WpItem[]>(creds, "GET", `/resource?${params.toString()}`, undefined, (response) => {
        const header = Number(response.headers.get("x-wp-total"));
        box.total = Number.isFinite(header) && header > 0 ? header : null;
    });
    return { items, total: box.total };
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

export async function getResource(creds: WpCreds, postId: number): Promise<WpItem> {
    return request<WpItem>(creds, "GET", `/resource/${postId}`);
}

/**
 * The resource permalink's last path segment is the slug. Plain permalinks
 * (?p=123) carry no slug segment and answer null; percent-encoded CJK slugs
 * come back decoded (the dir-name safety check rejects them anyway).
 */
export function parseSlugFromLink(link: string): string | null {
    try {
        const url = new URL(link);
        const segments = url.pathname.split("/").filter((segment) => segment !== "");
        const last = segments[segments.length - 1];
        return last ? decodeURIComponent(last) : null;
    } catch {
        return null;
    }
}

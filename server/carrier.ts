/**
 * The completion flow's carrier model ("文件补完"): one working directory per
 * post, holding the files staged for upload plus a `fileserve.json` that
 * plans the download groups. The carrier is the single source of truth while
 * the work is offline — the netdisk script (or a paste) fills share links
 * into it, and the completion push compiles it into the config the site
 * receives. Nothing here touches the database; see completion.ts for the
 * push orchestration.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeConfig, sanitizeId, type FileServeConfig } from "../shared/fileserve.js";
import type { PostRow } from "./db.js";

export const CARRIER_FILE = "fileserve.json";
export const CARRIER_VERSION = 1;

export type CarrierStatus = "draft" | "ready" | "pushed";
export type DirNameMode = "id" | "id-slug" | "slug";

export const DIR_NAME_MODES: DirNameMode[] = ["id", "id-slug", "slug"];

export function coerceDirNameMode(raw: string): DirNameMode {
    return DIR_NAME_MODES.includes(raw as DirNameMode) ? (raw as DirNameMode) : "id";
}

/**
 * One planned download group. Only the platform flow (netdisk share links)
 * is carried: the share step fills url/code, and the compile step emits the
 * group the FileServe domain expects. openlist/gofile groups stay with the
 * regular inline editor and the whole-row push.
 */
export interface CarrierGroup {
    /** The fileserve short id this group compiles into. */
    id: string;
    /** Which netdisk the files live on; the share script dispatches on it. */
    netdisk: string;
    /** The folder name to upload to and share, relative to the netdisk root. */
    remoteDir: string;
    title: string;
    price: number;
    url: string | null;
    code: string | null;
    /** ISO time the share was created; metadata for the share script. */
    sharedAt: string | null;
}

export interface CarrierFile {
    version: number;
    localId: number;
    postId: number;
    slug: string | null;
    dirName: string;
    createdAt: string;
    pushedAt: string | null;
    /** Digest of the config as last pushed — the "nothing new to push" yardstick. */
    pushedDigest: string | null;
    /** Display convenience, recomputed by scan; never authoritative. */
    status: CarrierStatus;
    groups: CarrierGroup[];
}

export interface GroupTemplate {
    netdisk: string;
    title: string;
    price: number;
}

export const DEFAULT_TEMPLATE: GroupTemplate[] = [
    { netdisk: "baidu", title: "百度网盘", price: 0 },
    { netdisk: "quark", title: "夸克网盘", price: 0 },
];

/** A slug is directory-safe only as pure URL-unreserved ASCII: WP
 * percent-encodes CJK slugs, and a percent sign makes a hostile directory
 * name; the length cap keeps Windows path limits comfortable. */
export function slugSafe(slug: string | null | undefined): slug is string {
    return typeof slug === "string" && slug !== "" && /^[A-Za-z0-9._~-]{1,80}$/.test(slug);
}

export function dirNameFor(postId: number, slug: string | null, mode: DirNameMode): string {
    if (mode !== "id" && slugSafe(slug)) {
        return mode === "slug" ? slug : `${postId}-${slug}`;
    }
    return String(postId);
}

export function parseTemplate(raw: string | null): { template: GroupTemplate[]; error: string | null } {
    if (raw === null || raw.trim() === "") {
        return { template: DEFAULT_TEMPLATE, error: null };
    }
    let decoded: unknown;
    try {
        decoded = JSON.parse(raw);
    } catch {
        return { template: [], error: "组模板不是可读的 JSON。" };
    }
    if (!Array.isArray(decoded) || decoded.length === 0) {
        return { template: [], error: "组模板必须是非空数组。" };
    }
    const template: GroupTemplate[] = [];
    for (const entry of decoded) {
        const item = entry as Record<string, unknown>;
        const netdisk = typeof item.netdisk === "string" ? item.netdisk.trim() : "";
        if (netdisk === "") {
            return { template: [], error: "组模板条目缺少 netdisk 标识。" };
        }
        const price = typeof item.price === "number" && Number.isFinite(item.price) ? Math.max(0, Math.trunc(item.price)) : 0;
        const title = typeof item.title === "string" && item.title.trim() !== "" ? item.title.trim() : netdisk;
        template.push({ netdisk, title, price });
    }
    return { template, error: null };
}

export function buildCarrier(row: PostRow, slug: string | null, dirName: string, template: GroupTemplate[]): CarrierFile {
    const groups: CarrierGroup[] = template.map((entry, index) => ({
        id: String(index + 1),
        netdisk: entry.netdisk,
        remoteDir: dirName,
        title: entry.title,
        price: entry.price,
        url: null,
        code: null,
        sharedAt: null,
    }));
    return {
        version: CARRIER_VERSION,
        localId: row.localId,
        postId: row.postId ?? 0,
        slug,
        dirName,
        createdAt: new Date().toISOString(),
        pushedAt: null,
        pushedDigest: null,
        status: "draft",
        groups,
    };
}

/**
 * Compile the carrier into the fileserve config: only groups carrying a
 * share link become entries. Placeholders would sit in the meta as groups
 * the delivery layer silently skips — valid, but noise in the metabox.
 */
export function compileConfig(carrier: CarrierFile): FileServeConfig {
    const config: FileServeConfig = {};
    for (const group of carrier.groups) {
        if (group.url === null || group.url.trim() === "") {
            continue;
        }
        const id = sanitizeId(group.id);
        // First wins on a sanitized-id collision, matching the domain's
        // parse semantics; only hand-edited carriers can collide.
        if (config[id] !== undefined) {
            continue;
        }
        config[id] = {
            adapter: "platform",
            url: group.url.trim(),
            code: group.code?.trim() ?? "",
            title: group.title,
            price: group.price,
        };
    }
    return config;
}

/** compileConfig builds keys and fields in a fixed order, so the canonical
 * JSON is a stable digest input. */
export function carrierDigest(config: FileServeConfig): string {
    return createHash("sha256").update(canonicalJson(config)).digest("hex").slice(0, 16);
}

/** Key-order-insensitive JSON: the digest must not move when the same
 * config passes through a different construction path (compileConfig vs
 * normalizeConfig differ in field order alone). */
function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

export function carrierStatus(carrier: CarrierFile): CarrierStatus {
    const config = compileConfig(carrier);
    if (Object.keys(config).length === 0) {
        return "draft";
    }
    if (carrier.pushedDigest !== null && carrier.pushedDigest === carrierDigest(config)) {
        return "pushed";
    }
    return "ready";
}

export function readCarrier(path: string): CarrierFile {
    let decoded: unknown;
    try {
        decoded = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        throw new Error("载体文件不是可读的 JSON。");
    }
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
        throw new Error("载体文件形状不对。");
    }
    const raw = decoded as Record<string, unknown>;
    if (raw.version !== CARRIER_VERSION) {
        throw new Error(`载体版本不支持：${String(raw.version)}`);
    }
    const localId = Number(raw.localId);
    const postId = Number(raw.postId);
    if (!Number.isInteger(localId) || localId <= 0 || !Number.isInteger(postId) || postId <= 0) {
        throw new Error("载体缺少有效的 localId/postId。");
    }
    const groups: CarrierGroup[] = [];
    if (Array.isArray(raw.groups)) {
        for (const entry of raw.groups) {
            const group = entry as Record<string, unknown>;
            const id = sanitizeId(typeof group.id === "string" ? group.id : "");
            if (id === "" || typeof group.netdisk !== "string") {
                throw new Error("载体里有无法读取的数据组。");
            }
            groups.push({
                id,
                netdisk: group.netdisk,
                remoteDir: typeof group.remoteDir === "string" ? group.remoteDir : "",
                title: typeof group.title === "string" ? group.title : "",
                price: typeof group.price === "number" && Number.isFinite(group.price) ? Math.max(0, Math.trunc(group.price)) : 0,
                url: typeof group.url === "string" && group.url.trim() !== "" ? group.url.trim() : null,
                code: typeof group.code === "string" && group.code.trim() !== "" ? group.code.trim() : null,
                sharedAt: typeof group.sharedAt === "string" ? group.sharedAt : null,
            });
        }
    } else {
        throw new Error("载体的 groups 不是数组。");
    }
    const carrier: CarrierFile = {
        version: CARRIER_VERSION,
        localId,
        postId,
        slug: typeof raw.slug === "string" && raw.slug !== "" ? raw.slug : null,
        dirName: typeof raw.dirName === "string" ? raw.dirName : "",
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
        pushedAt: typeof raw.pushedAt === "string" ? raw.pushedAt : null,
        pushedDigest: typeof raw.pushedDigest === "string" ? raw.pushedDigest : null,
        status: "draft",
        groups,
    };
    carrier.status = carrierStatus(carrier);
    return carrier;
}

function writeCarrier(path: string, carrier: CarrierFile): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(carrier, null, 4)}\n`, "utf8");
    renameSync(tmp, path);
}

/** The whole carrier is rebuilt on write — a hand-added note in the JSON
 * does not survive a push, by design: the schema above is the contract. */
export function markCarrierPushed(path: string, carrier: CarrierFile, config: FileServeConfig): void {
    writeCarrier(path, {
        ...carrier,
        status: "pushed",
        pushedAt: new Date().toISOString(),
        pushedDigest: carrierDigest(config),
    });
}

export interface SinkEntry {
    dirName: string;
    path: string;
    status: CarrierStatus | "broken";
    error: string | null;
    carrier: CarrierFile | null;
}

/** Read-only sweep of the working directory: every first-level folder that
 * holds a carrier. Folders without one are plain upload staging. */
export function listSinks(workRoot: string): SinkEntry[] {
    const root = workRoot.trim();
    if (root === "" || !existsSync(root)) {
        return [];
    }
    const entries: SinkEntry[] = [];
    for (const item of readdirSync(root, { withFileTypes: true })) {
        if (!item.isDirectory()) {
            continue;
        }
        const path = join(root, item.name, CARRIER_FILE);
        if (!existsSync(path)) {
            continue;
        }
        try {
            const carrier = readCarrier(path);
            entries.push({ dirName: item.name, path, status: carrier.status, error: null, carrier });
        } catch (error) {
            entries.push({
                dirName: item.name,
                path,
                status: "broken",
                error: error instanceof Error ? error.message : String(error),
                carrier: null,
            });
        }
    }
    return entries;
}

export interface GenerateOptions {
    workRoot: string;
    dirNameMode: DirNameMode;
    template: GroupTemplate[];
}

export function generateSink(
    row: PostRow,
    slug: string | null,
    options: GenerateOptions,
): { dirName: string; path: string; carrier: CarrierFile } {
    if (row.postId === null) {
        throw new Error("这一行还没有推送到站点，先推送发布再生成文件骨架。");
    }
    const { config } = normalizeConfig(row.fileserve);
    if (Object.keys(config).length > 0) {
        throw new Error("这一行已有文件列表配置；补完推送会整体替换它，请直接在编辑器里维护。");
    }
    const dirName = dirNameFor(row.postId, slug, options.dirNameMode);
    const dir = join(options.workRoot, dirName);
    const path = join(dir, CARRIER_FILE);
    if (existsSync(path)) {
        throw new Error(`骨架已存在：${path}`);
    }
    const carrier = buildCarrier(row, slug, dirName, options.template);
    mkdirSync(dir, { recursive: true });
    writeCarrier(path, carrier);
    return { dirName, path, carrier };
}

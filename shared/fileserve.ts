/**
 * TypeScript replica of the FileServe data model (aiya-core
 * Domain/FileServe/Config and the aiya-publish plugin's FileServeConfig):
 * one JSON object keyed by auto-generated short ids, every group naming its
 * adapter and carrying that adapter's fields plus the common title/price
 * pair. Normalization mirrors the PHP semantics so an edited row pushes a
 * configuration the domain accepts byte for byte.
 */

export interface FieldDef {
    id: string;
    type: "text" | "number";
    default: string | number;
    min?: number;
}

export const ADAPTER_FIELDS: Record<string, FieldDef[]> = {
    platform: [
        { id: "url", type: "text", default: "" },
        { id: "code", type: "text", default: "" },
    ],
    openlist_list: [
        { id: "path", type: "text", default: "" },
        { id: "password", type: "text", default: "" },
        { id: "per_page", type: "number", default: 0, min: 0 },
    ],
    openlist_search: [
        { id: "keywords", type: "text", default: "" },
        { id: "parent", type: "text", default: "" },
        { id: "password", type: "text", default: "" },
        { id: "per_page", type: "number", default: 0, min: 0 },
    ],
    gofile_api: [{ id: "folder_id", type: "text", default: "" }],
};

export const COMMON_FIELDS: FieldDef[] = [
    { id: "title", type: "text", default: "" },
    { id: "price", type: "number", default: 0, min: 0 },
];

/** Suggested per-file price the editor pre-fills; site snapshots still normalize to 0. */
export const ADAPTER_PRICE_DEFAULTS: Record<string, number> = {
    platform: 2,
    openlist_list: 10,
    openlist_search: 10,
    gofile_api: 10,
};

export function priceDefault(adapter: string): number {
    return ADAPTER_PRICE_DEFAULTS[adapter] ?? 10;
}

/** Chinese labels for the editor; unknown ids fall back to the raw field name. */
export const FIELD_LABELS: Record<string, string> = {
    title: "标题",
    price: "售价（积分）",
    url: "链接",
    code: "提取码",
    path: "路径",
    password: "密码",
    per_page: "每页数量",
    keywords: "关键词",
    parent: "父目录",
    folder_id: "文件夹 ID",
};

export function fieldLabel(id: string): string {
    return FIELD_LABELS[id] ?? id;
}


export const ADAPTER_LABELS: Record<string, string> = {
    platform: "网盘链接",
    openlist_list: "OpenList 目录",
    openlist_search: "OpenList 搜索",
    gofile_api: "GoFile",
};

export type FieldValue = string | number | null;
/** One group. `netdisk` is a local-only extension the production domain never
 * sees: which netdisk pipeline owns this group (baidu/quark/…). It decides
 * lane claiming (empty link + matching netdisk = work for that pipeline) and
 * is stripped from the payload; the site drops it anyway. */
export type FileGroup = Record<string, FieldValue> & { adapter: string; netdisk?: string };
export type FileServeConfig = Record<string, FileGroup>;

/** The known netdisk pipelines. Adding a pipeline = one entry here plus a
 * script instance asking the queue for its id. */
export const NETDISK_OPTIONS: { id: string; label: string }[] = [
    { id: "baidu", label: "百度网盘" },
    { id: "quark", label: "夸克网盘" },
];

export function netdiskLabel(id: string | undefined): string {
    return NETDISK_OPTIONS.find((option) => option.id === id)?.label ?? (id || "baidu");
}

/** A group's owning pipeline; groups predating the field default to baidu. */
export function groupNetdisk(group: FileGroup): string {
    return typeof group.netdisk === "string" && group.netdisk.trim() !== "" ? group.netdisk : "baidu";
}
/** A submitted key reduced to something storable; "" when nothing is left of it. */
export function sanitizeId(raw: string): string {
    return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
}

/** Loose stand-in for PHP's sanitize_text_field: no tags, collapsed blank edges. */
function sanitizeText(value: string): string {
    return value.replace(/<[^>]*>/g, "").trim();
}

export function normalizeConfig(raw: unknown): { config: FileServeConfig; errors: string[] } {
    if (raw === null || raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0)) {
        return { config: {}, errors: [] };
    }

    let decoded: unknown = raw;
    if (typeof raw === "string") {
        try {
            decoded = JSON.parse(raw);
        } catch {
            return { config: {}, errors: ["文件配置不是可读的 JSON。"] };
        }
    }
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
        return { config: {}, errors: ["文件配置不是可读的 JSON。"] };
    }

    const config: FileServeConfig = {};
    const errors: string[] = [];

    for (const [rawId, rawGroup] of Object.entries(decoded as Record<string, unknown>)) {
        const id = sanitizeId(rawId);
        if (id === "") {
            errors.push("有数据组键名无法读取。");
            continue;
        }
        if (rawGroup === null || typeof rawGroup !== "object" || Array.isArray(rawGroup)) {
            errors.push(`数据组 ${id} 无法读取。`);
            continue;
        }

        const group = rawGroup as Record<string, unknown>;
        const adapter = typeof group.adapter === "string" ? group.adapter : "";
        const fields = ADAPTER_FIELDS[adapter];
        if (!fields) {
            errors.push(`数据组 ${id} 使用的适配器不可用：${adapter || "（空）"}。`);
            continue;
        }

        const normalized: Record<string, FieldValue> = {};
        let broken = false;
        for (const field of [...fields, ...COMMON_FIELDS]) {
            const value = group[field.id] ?? field.default;
            if (field.type === "text") {
                normalized[field.id] = sanitizeText(String(value ?? ""));
                continue;
            }
            if (value === "" || value === null || value === undefined) {
                normalized[field.id] = null;
                continue;
            }
            const num = typeof value === "number" ? value : Number(value);
            if (!Number.isFinite(num)) {
                errors.push(`数据组 ${id} 的字段 ${field.id} 不是数字。`);
                broken = true;
                break;
            }
            normalized[field.id] = field.min !== undefined ? Math.max(field.min, num) : num;
        }
        if (broken) {
            continue;
        }

        normalized.price = Math.max(0, Math.trunc(Number(normalized.price ?? 0)));
        config[id] = {
            ...normalized,
            adapter,
            ...(typeof group.netdisk === "string" && group.netdisk.trim() !== ""
                ? { netdisk: group.netdisk.trim().slice(0, 16) }
                : {}),
        } as FileGroup;
    }

    if (errors.length > 0) {
        return { config: {}, errors };
    }
    return { config, errors: [] };
}

/** All fields at their defaults, ready for the editor. A platform group
 * targets the baidu pipeline by default and its title carries the netdisk
 * name — empty titles are not a valid state. */
export function emptyGroup(adapter: string): FileGroup {
    const group: FileGroup = { adapter };
    for (const field of [...(ADAPTER_FIELDS[adapter] ?? []), ...COMMON_FIELDS]) {
        group[field.id] = field.default;
    }
    // The declared default (0) lands first; the adapter suggestion wins.
    group.price = priceDefault(adapter);
    if (adapter === "platform") {
        group.netdisk = "baidu";
        group.title = netdiskLabel("baidu");
    }
    return group;
}

/** The production payload for a row: every group that carries its link, with
 * the local netdisk field stripped. Empty-link platform groups stay local —
 * they are the netdisk pipeline's pending work items, not publishable
 * entries — so a pushed row never carries a dead download entry. */
export function productionConfig(config: FileServeConfig): FileServeConfig {
    const effective: FileServeConfig = {};
    for (const [id, group] of Object.entries(config)) {
        if (group.adapter === "platform" && (typeof group.url !== "string" || group.url.trim() === "")) {
            continue;
        }
        const { netdisk, ...production } = group;
        effective[id] = production as FileGroup;
    }
    return effective;
}

/** The local file list after a site confirmation. The site is authoritative
 * for what it carries (each surviving group gets its local netdisk field
 * re-attached — the site dropped it), and a local group the site does not
 * know survives only while its link is still empty: those are the
 * pipeline's pending work items. A filled group missing from the site was
 * deleted there, and that deletion propagates. */
export function mergeRemoteFileserve(remote: unknown, localRaw: string | null): string | null {
    const remoteConfig =
        remote !== null && typeof remote === "object" && !Array.isArray(remote) ? (remote as FileServeConfig) : null;
    const local = localRaw ? normalizeConfig(localRaw).config : {};
    const merged: FileServeConfig = {};
    for (const [id, group] of Object.entries(remoteConfig ?? {})) {
        const localGroup = local[id];
        merged[id] = {
            ...group,
            ...(localGroup?.netdisk !== undefined ? { netdisk: localGroup.netdisk } : {}),
        } as FileGroup;
    }
    for (const [id, group] of Object.entries(local)) {
        if (merged[id] === undefined && group.adapter === "platform" && (typeof group.url !== "string" || group.url.trim() === "")) {
            merged[id] = { ...group };
        }
    }
    if (Object.keys(merged).length === 0) {
        return remoteConfig !== null ? "{}" : null;
    }
    return JSON.stringify(merged);
}

/** The next free short id: one past the highest numeric key, like the domain. */
export function nextId(config: FileServeConfig): string {
    let highest = 0;
    for (const key of Object.keys(config)) {
        if (/^\d+$/.test(key)) {
            highest = Math.max(highest, Number.parseInt(key, 10));
        }
    }
    return String(highest + 1);
}

/** A display summary: how many groups and what they cost per file in total. */
export function configSummary(config: FileServeConfig | null): string {
    if (!config) {
        return "—";
    }
    const groups = Object.keys(config).length;
    const total = Object.values(config).reduce(
        (sum, group) => sum + (typeof group.price === "number" ? group.price : 0),
        0,
    );
    return `${groups} 组 · ${total} 分/次`;
}

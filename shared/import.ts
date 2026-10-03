/**
 * CSV import for the publishing queue: parse a spreadsheet into dirty local
 * rows. Everything here is pure — the server runs it authoritatively for
 * /api/import/apply, the client runs the exact same code for the live
 * mapping preview, so what the preview counts is what the import writes.
 *
 * Field semantics mirror the WP plugin's Payload validation (title non-empty
 * after trim, the three statuses, "YYYY-MM-DD[ T]HH:MM[:SS]" wall-clock
 * dates) so a row that survives the import does not die at push time.
 */

import type { ParsedCsv } from "./csv.js";
import { mergeTermTokens, splitTermInput, type TermOption } from "./terms.js";

/** The resource type's taxonomy registry, in the fixed display order. */
export const TAXONOMY_ORDER = [
    "resource_category",
    "resource_original",
    "resource_character",
    "resource_author",
    "resource_content",
    "resource_other",
] as const;

export const TAXONOMY_LABELS: Record<string, string> = {
    resource_category: "分类",
    resource_original: "原作",
    resource_character: "角色",
    resource_author: "作者",
    resource_content: "内容描述",
    resource_other: "其他",
};

/** Import refuses beyond this; a local SQLite write is cheap but a 16 MB body is not. */
export const IMPORT_MAX_ROWS = 5000;

export interface ImportTargetSpec {
    key: string;
    label: string;
    kind: "title" | "content" | "status" | "date" | "author" | "term";
    taxonomy?: string;
}

/**
 * The mappable targets. Note the deliberate split: "发布者(账号)" is the post
 * author (a user id), while the resource_author taxonomy — labeled plain
 * "作者" in the taxonomy registry — is a term column. The aliases follow the
 * same split: a bare "作者" header is the term, never the account.
 */
export const BASE_IMPORT_TARGETS: ImportTargetSpec[] = [
    { key: "title", label: "标题", kind: "title" },
    { key: "content", label: "正文", kind: "content" },
    { key: "status", label: "状态", kind: "status" },
    { key: "date", label: "发布时间", kind: "date" },
    { key: "author", label: "发布者(账号)", kind: "author" },
];

export function importTargets(): ImportTargetSpec[] {
    return [
        ...BASE_IMPORT_TARGETS,
        ...TAXONOMY_ORDER.map(
            (taxonomy): ImportTargetSpec => ({
                key: `term:${taxonomy}`,
                label: `${TAXONOMY_LABELS[taxonomy]}(标签)`,
                kind: "term",
                taxonomy,
            }),
        ),
    ];
}

/** Column index per target key; null or absent = the target is not imported. */
export interface ImportMapping {
    [target: string]: number | null;
}

const ALIASES: Record<string, string[]> = {
    title: ["标题", "帖子标题", "资源标题", "名称", "题目", "title", "name"],
    content: ["正文", "内容", "描述", "简介", "content", "body", "description"],
    status: ["状态", "发布状态", "status"],
    date: ["发布时间", "日期", "时间", "date", "datetime", "time"],
    author: ["发布者", "发布账号", "账号", "author", "username", "user"],
    "term:resource_category": ["分类", "目录", "category", "categories"],
    "term:resource_original": ["原作", "原作作品", "作品", "original"],
    "term:resource_character": ["角色", "人物", "character"],
    "term:resource_author": ["作者", "作者标签", "author_tag"],
    "term:resource_content": ["内容描述", "内容标签", "content_tag"],
    "term:resource_other": ["其他", "other"],
};

/**
 * First-fit auto-guess: targets in the order above claim columns by exact
 * (case-insensitive, trimmed) header match, and a claimed column is never
 * reused — two targets aliasing the same header resolve to the earlier one.
 */
export function guessMapping(headers: string[]): ImportMapping {
    const mapping: ImportMapping = {};
    const used = new Set<number>();
    const normalized = headers.map((header) => header.trim().toLowerCase());
    for (const [key, aliases] of Object.entries(ALIASES)) {
        mapping[key] = null;
        for (const alias of aliases) {
            const index = normalized.findIndex((header, i) => !used.has(i) && header === alias);
            if (index >= 0) {
                mapping[key] = index;
                used.add(index);
                break;
            }
        }
    }
    return mapping;
}

const STATUS_ALIASES: Record<string, string> = {
    publish: "publish",
    published: "publish",
    发布: "publish",
    已发布: "publish",
    公开: "publish",
    draft: "draft",
    草稿: "draft",
    future: "future",
    scheduled: "future",
    定时: "future",
    预约: "future",
};

export function normalizeImportStatus(raw: string): string | null {
    const value = raw.trim();
    return STATUS_ALIASES[value.toLowerCase()] ?? STATUS_ALIASES[value] ?? null;
}

/**
 * Folds the shapes a spreadsheet actually exports — "2026-10-05",
 * "2026/10/5 9:30", "2026年10月5日 09:30:00", "2026-10-05T09:30" — into the
 * tool's minute-precision "YYYY-MM-DDTHH:mm" wall-clock form. No timezone
 * math: a CSV date is wall-clock intent by definition, exactly what the WP
 * side's date field takes at face value. "" for an empty cell, null for
 * unparseable.
 */
export function normalizeImportDate(raw: string): string | null {
    const value = raw.trim();
    if (value === "") {
        return "";
    }
    const m = /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?(?:[\sT时]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?时?$/.exec(value);
    if (!m) {
        return null;
    }
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const [hour, minute, second] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
    if (hour > 23 || minute > 59 || second > 59) {
        return null;
    }
    // Reject day overflow the regex can't see (2026-02-31): Date.UTC rolls
    // it over, so the round-trip must land on the same month/day.
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
        return null;
    }
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

export interface BuildOptions {
    authors: { id: number; name: string }[];
    termOptions: Record<string, TermOption[]>;
    defaultStatus: string;
    defaultAuthorId: number | null;
    /** What an unmatched non-empty author cell does: kill the row, or fall back to the default. */
    unmatchedAuthor: "error" | "default";
}

export interface ImportRow {
    status: string;
    title: string;
    content: string;
    authorId: number | null;
    dateLocal: string;
    termRefs: Record<string, string[]>;
}

export interface ImportRowError {
    /** 1-based data-row ordinal (the header line is not counted). */
    row: number;
    title: string;
    error: string;
}

export interface BuildResult {
    rows: ImportRow[];
    errors: ImportRowError[];
    /** Import-level refusal (no title column, row cap); nothing is written when set. */
    fatal: string | null;
}

function resolveAuthor(
    raw: string,
    options: BuildOptions,
): { authorId: number | null; error: string | null } {
    const value = raw.trim();
    if (value === "") {
        return { authorId: options.defaultAuthorId, error: null };
    }
    if (/^\d+$/.test(value)) {
        const id = Number(value);
        return options.authors.some((author) => author.id === id)
            ? { authorId: id, error: null }
            : { authorId: null, error: `作者 id 不存在：${value}` };
    }
    const exact = options.authors.find((author) => author.name === value);
    const match = exact ?? options.authors.find((author) => author.name.toLowerCase() === value.toLowerCase());
    if (match) {
        return { authorId: match.id, error: null };
    }
    if (options.unmatchedAuthor === "default") {
        return { authorId: options.defaultAuthorId, error: null };
    }
    return { authorId: null, error: `作者未匹配：${value}` };
}

export function buildImportRows(parsed: ParsedCsv, mapping: ImportMapping, options: BuildOptions): BuildResult {
    if (typeof mapping.title !== "number") {
        return { rows: [], errors: [], fatal: "未映射「标题」列——标题是每行必需的。" };
    }
    if (parsed.rows.length > IMPORT_MAX_ROWS) {
        return { rows: [], errors: [], fatal: `一次最多导入 ${IMPORT_MAX_ROWS} 行（当前 ${parsed.rows.length} 行）。` };
    }

    const rows: ImportRow[] = [];
    const errors: ImportRowError[] = [];

    parsed.rows.forEach((cells, index) => {
        const rowNumber = index + 1;
        const cell = (target: string): string => {
            const column = mapping[target];
            return typeof column === "number" ? (cells[column] ?? "").trim() : "";
        };
        const problems: string[] = [];

        const title = cell("title");
        if (title === "") {
            problems.push("标题为空");
        }

        let status = options.defaultStatus;
        const rawStatus = cell("status");
        if (rawStatus !== "") {
            const normalized = normalizeImportStatus(rawStatus);
            if (normalized === null) {
                problems.push(`状态无法识别：${rawStatus}`);
            } else {
                status = normalized;
            }
        }

        let dateLocal = "";
        const rawDate = cell("date");
        if (rawDate !== "") {
            const normalized = normalizeImportDate(rawDate);
            if (normalized === null) {
                problems.push(`发布时间无法解读：${rawDate}`);
            } else {
                dateLocal = normalized;
            }
        }
        if (status === "future" && dateLocal === "") {
            problems.push("定时（future）行必须携带发布时间");
        }

        const author = resolveAuthor(cell("author"), options);
        if (author.error !== null) {
            problems.push(author.error);
        }

        const termRefs: Record<string, string[]> = {};
        for (const target of importTargets()) {
            if (target.kind !== "term" || target.taxonomy === undefined || typeof mapping[target.key] !== "number") {
                continue;
            }
            const refs = mergeTermTokens([], splitTermInput(cell(target.key)), options.termOptions[target.taxonomy] ?? []);
            if (refs.length > 0) {
                termRefs[target.taxonomy] = refs;
            }
        }

        if (problems.length > 0) {
            errors.push({ row: rowNumber, title: title === "" ? `（第 ${rowNumber} 行）` : title, error: problems.join("；") });
            return;
        }
        rows.push({
            status,
            title,
            content: cell("content"),
            authorId: author.authorId,
            dateLocal,
            termRefs,
        });
    });

    return { rows, errors, fatal: null };
}

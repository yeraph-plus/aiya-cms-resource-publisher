/**
 * The ingest contract: one structured payload — an agent's or the intake
 * window's output — turned into dirty local rows. Everything here is pure, so
 * the server runs it authoritatively for /api/ingest and /api/ingest/preview
 * and the preview shows exactly the rows the write would create.
 *
 * Field semantics mirror the CSV importer (title non-empty after trim, the
 * three statuses, wall-clock dates, a term name that does not exist yet
 * becoming a `name:` reference) and add the two things a spreadsheet cell
 * cannot carry: a whole term list per taxonomy, and the file list.
 */

import { normalizeConfig } from "./fileserve.js";
import { normalizeImportDate, normalizeImportStatus, TAXONOMY_LABELS, TAXONOMY_ORDER } from "./import.js";
import { mergeTermTokens, type TermOption } from "./terms.js";

/**
 * Refused beyond this. The CSV cap is 5000 because a spreadsheet is cheap to
 * write; an ingest round is one model answer, so a payload past this size is
 * a mistake rather than a workload.
 */
export const INGEST_MAX_ROWS = 500;

export interface IngestBuildOptions {
    authors: { id: number; name: string }[];
    /** Known terms per taxonomy; a name found here folds to its id. */
    termOptions: Record<string, TermOption[]>;
    defaultStatus: string;
    defaultAuthorId: number | null;
    /**
     * The file list a row starts with when the payload says nothing about it —
     * the 挂网盘待办组 setting, already serialized. Absent/null = rows start
     * with no file list; an explicit `fileserve: null` in the payload also
     * means "none", so a script can opt out row by row.
     */
    defaultFileserve?: string | null;
}

/** The shape the DB writes: one dirty row plus its file list. */
export interface IngestRow {
    status: string;
    title: string;
    content: string;
    authorId: number | null;
    dateLocal: string;
    termRefs: Record<string, string[]>;
    /** The normalized file list as the DB column value; null = no file list. */
    fileserve: string | null;
}

export interface IngestRowError {
    /** 1-based ordinal inside the submitted array. */
    row: number;
    title: string;
    error: string;
}

export interface IngestWarning {
    /** 1-based ordinal inside the submitted array. */
    row: number;
    title: string;
    warning: string;
}

export interface IngestResult {
    rows: IngestRow[];
    errors: IngestRowError[];
    /** Non-fatal notes (an ambiguous term name); the row is written anyway. */
    warnings: IngestWarning[];
    /** Payload-level refusal (no rows, wrong shape, row cap); nothing is written when set. */
    fatal: string | null;
}

const KNOWN_TAXONOMIES = new Set<string>(TAXONOMY_ORDER);

function taxonomyLabel(taxonomy: string): string {
    return TAXONOMY_LABELS[taxonomy] ?? taxonomy;
}

/**
 * A term list is names or ids, mixed. An id must already exist — silently
 * inventing one would push a 400 at the site later; an unknown *name* is the
 * documented way to create a term on push (`name:`), so it passes through.
 */
function resolveTerms(
    raw: unknown,
    options: IngestBuildOptions,
): { refs: Record<string, string[]>; problems: string[]; notes: string[] } {
    const refs: Record<string, string[]> = {};
    const problems: string[] = [];
    const notes: string[] = [];
    if (raw === null || raw === undefined) {
        return { refs, problems, notes };
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
        return { refs, problems: ["terms 必须是「词法 → 名称或 id 数组」的对象。"], notes };
    }

    for (const [taxonomy, list] of Object.entries(raw as Record<string, unknown>)) {
        if (!KNOWN_TAXONOMIES.has(taxonomy)) {
            problems.push(`未知词法：${taxonomy}`);
            continue;
        }
        if (list === null || list === undefined) {
            continue;
        }
        if (!Array.isArray(list)) {
            problems.push(`${taxonomyLabel(taxonomy)}的术语必须是数组。`);
            continue;
        }

        const known = options.termOptions[taxonomy] ?? [];
        let current: string[] = [];
        for (const item of list) {
            const numeric =
                typeof item === "number" ? item : typeof item === "string" && /^\d+$/.test(item.trim()) ? Number(item.trim()) : null;
            if (numeric !== null) {
                if (!known.some((option) => option.id === numeric)) {
                    problems.push(`${taxonomyLabel(taxonomy)}里没有 id ${numeric} 的术语`);
                    continue;
                }
                const ref = String(numeric);
                if (!current.includes(ref)) {
                    current.push(ref);
                }
                continue;
            }
            if (typeof item !== "string" || item.trim() === "") {
                problems.push(`${taxonomyLabel(taxonomy)}的术语必须是名称或 id。`);
                continue;
            }
            // The same name under several parents is legal in WP. The list is
            // usage-ordered, so the fold below takes the term this site uses
            // most; say so, because by name alone the two are the same thing.
            const matches = known.filter((option) => option.name.toLowerCase() === item.trim().toLowerCase());
            if (matches.length > 1) {
                const pick = matches[0];
                notes.push(
                    `${taxonomyLabel(taxonomy)}「${item.trim()}」有 ${matches.length} 个同名术语，已取使用最多的 #${pick ? pick.id : ""}`,
                );
            }
            // mergeTermTokens folds a known name to its id and leaves an
            // unknown one as `name:…`, deduped case-insensitively.
            current = mergeTermTokens(current, [item], known);
        }
        if (current.length > 0) {
            refs[taxonomy] = current;
        }
    }

    return { refs, problems, notes };
}

/** An id, a display name, or nothing (= the configured default author). */
function resolveAuthor(raw: unknown, options: IngestBuildOptions): { authorId: number | null; problem: string | null } {
    if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
        return { authorId: options.defaultAuthorId, problem: null };
    }
    const numeric = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
    if (numeric !== null) {
        return options.authors.some((author) => author.id === numeric)
            ? { authorId: numeric, problem: null }
            : { authorId: null, problem: `作者 id 不存在：${numeric}` };
    }
    if (typeof raw === "string") {
        const value = raw.trim();
        const match =
            options.authors.find((author) => author.name === value) ??
            options.authors.find((author) => author.name.toLowerCase() === value.toLowerCase());
        if (match) {
            return { authorId: match.id, problem: null };
        }
        return { authorId: null, problem: `作者未匹配：${value}` };
    }
    return { authorId: null, problem: "作者必须是 id 或显示名。" };
}

/**
 * One incoming row → one dirty row or one error. Every problem of a row is
 * collected into a single message, the same way the CSV importer reports.
 */
function buildRow(
    raw: unknown,
    index: number,
    options: IngestBuildOptions,
): { row: IngestRow | null; error: IngestRowError | null; notes: string[] } {
    const ordinal = index + 1;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return {
            row: null,
            error: { row: ordinal, title: `（第 ${ordinal} 行）`, error: "每一行必须是一个对象。" },
            notes: [],
        };
    }

    const source = raw as Record<string, unknown>;
    const problems: string[] = [];

    const title = String(source.title ?? "").trim();
    if (title === "") {
        problems.push("标题为空");
    }
    const content = String(source.content ?? "").trim();

    let status = options.defaultStatus;
    const rawStatus = source.status;
    if (rawStatus !== null && rawStatus !== undefined && String(rawStatus).trim() !== "") {
        const normalized = normalizeImportStatus(String(rawStatus));
        if (normalized === null) {
            problems.push(`状态无法识别：${String(rawStatus)}`);
        } else {
            status = normalized;
        }
    }

    let dateLocal = "";
    const rawDate = source.dateLocal;
    if (rawDate !== null && rawDate !== undefined && String(rawDate).trim() !== "") {
        const normalized = normalizeImportDate(String(rawDate));
        if (normalized === null) {
            problems.push(`发布时间无法解读：${String(rawDate)}`);
        } else {
            dateLocal = normalized;
        }
    }
    if (status === "future" && dateLocal === "") {
        problems.push("定时（future）行必须携带发布时间");
    }

    const author = resolveAuthor(source.authorId, options);
    if (author.problem !== null) {
        problems.push(author.problem);
    }

    const terms = resolveTerms(source.terms, options);
    problems.push(...terms.problems);

    // The file list is the whole configuration (unknown keys dropped, defaults
    // filled, price folded) — the same normalization the detail editor and the
    // push path run. An empty object means "no file list" here: this is a row
    // that does not exist on the site yet, so there is nothing to clear.
    // Nothing said at all = whatever the 挂网盘待办组 setting attaches.
    let fileserve: string | null = null;
    const rawFileserve = source.fileserve;
    if (rawFileserve === undefined) {
        fileserve = options.defaultFileserve ?? null;
    } else if (rawFileserve !== null) {
        if (typeof rawFileserve !== "object" || Array.isArray(rawFileserve)) {
            problems.push("fileserve 必须是「组 id → 组字段」的对象（数组与字符串都不接受）。");
        } else {
            const { config, errors } = normalizeConfig(rawFileserve);
            if (errors.length > 0) {
                problems.push(errors.join(" "));
            } else if (Object.keys(config).length > 0) {
                fileserve = JSON.stringify(config);
            }
        }
    }

    if (problems.length > 0) {
        return {
            row: null,
            error: { row: ordinal, title: title === "" ? `（第 ${ordinal} 行）` : title, error: problems.join("；") },
            notes: terms.notes,
        };
    }

    return {
        row: { status, title, content, authorId: author.authorId, dateLocal, termRefs: terms.refs, fileserve },
        error: null,
        notes: terms.notes,
    };
}

export function buildIngestRows(rawRows: unknown, options: IngestBuildOptions): IngestResult {
    if (!Array.isArray(rawRows)) {
        return { rows: [], errors: [], warnings: [], fatal: "请求里没有 rows 数组。" };
    }
    if (rawRows.length === 0) {
        return { rows: [], errors: [], warnings: [], fatal: "没有可摄取的行。" };
    }
    if (rawRows.length > INGEST_MAX_ROWS) {
        return {
            rows: [],
            errors: [],
            warnings: [],
            fatal: `一次最多摄取 ${INGEST_MAX_ROWS} 行（当前 ${rawRows.length} 行）。`,
        };
    }

    const rows: IngestRow[] = [];
    const errors: IngestRowError[] = [];
    const warnings: IngestWarning[] = [];
    rawRows.forEach((raw, index) => {
        const built = buildRow(raw, index, options);
        if (built.row !== null) {
            rows.push(built.row);
        }
        if (built.error !== null) {
            errors.push(built.error);
        }
        for (const warning of built.notes) {
            warnings.push({
                row: index + 1,
                title: built.row?.title ?? built.error?.title ?? `（第 ${index + 1} 行）`,
                warning,
            });
        }
    });

    return { rows, errors, warnings, fatal: null };
}
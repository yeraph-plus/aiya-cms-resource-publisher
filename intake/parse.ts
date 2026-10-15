/**
 * Model answer → draft. Models wrap JSON in prose or fences, and they answer
 * with a bare string where a one-element array was asked for; both are cheap to
 * absorb here so the window's editor gets a usable draft instead of a parse
 * error. Nothing is repaired silently beyond that: a missing title stays
 * missing and the window shows it empty.
 */

export interface Draft {
    title: string;
    content: string;
    terms: Record<string, string[]>;
    newTerms: Record<string, string[]>;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** The first JSON value in the text: fenced, bare, or surrounded by prose. */
export function extractJson(text: string): ParseResult<unknown> {
    const trimmed = text.trim();
    if (trimmed === "") {
        return { ok: false, error: "模型返回了空内容。" };
    }

    const unfenced = trimmed
        .replace(/^```[a-zA-Z]*\s*/, "")
        .replace(/\s*```$/, "")
        .trim();

    for (const candidate of [unfenced, trimmed]) {
        try {
            return { ok: true, value: JSON.parse(candidate) };
        } catch {
            // Fall through to the bracket slice below.
        }
    }

    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) {
        try {
            return { ok: true, value: JSON.parse(unfenced.slice(start, end + 1)) };
        } catch (error) {
            return { ok: false, error: `解析模型返回的 JSON 失败：${error instanceof Error ? error.message : String(error)}` };
        }
    }
    return { ok: false, error: "模型返回里找不到 JSON 对象。" };
}

/** A term list as the model wrote it: an array, or one bare word. */
function asStringList(value: unknown): string[] {
    if (typeof value === "string") {
        return value.trim() === "" ? [] : [value.trim()];
    }
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((item) => (typeof item === "string" ? item.trim() : typeof item === "number" ? String(item) : ""))
        .filter((item) => item !== "");
}

function asTermMap(value: unknown): Record<string, string[]> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    const result: Record<string, string[]> = {};
    for (const [taxonomy, list] of Object.entries(value as Record<string, unknown>)) {
        const words = asStringList(list);
        if (words.length > 0) {
            result[taxonomy] = words;
        }
    }
    return result;
}

export function toDraft(value: unknown): ParseResult<Draft> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, error: "模型返回的不是一个 JSON 对象。" };
    }
    const source = value as Record<string, unknown>;
    const title = typeof source.title === "string" ? source.title.trim() : "";
    if (title === "") {
        return { ok: false, error: "模型返回的对象里没有 title。" };
    }

    // Status, author, date and the file list are the publisher's own settings
    // now: a model that still emits them is ignored rather than obeyed.
    return {
        ok: true,
        value: {
            title,
            content: typeof source.content === "string" ? source.content.trim() : "",
            terms: asTermMap(source.terms),
            newTerms: asTermMap(source.newTerms),
        },
    };
}
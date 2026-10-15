/**
 * The intake window's own configuration: which model to call, with which key,
 * and the prompt templates the window switches between.
 *
 * It is *stored in the publishing tool's database* (table intake_config, one
 * JSON blob) instead of a file next to it, so the packaged app has exactly one
 * data store to back up, move or delete. That makes this module half of a pair:
 * everything here is pure — the shape, the defaults, the never-throwing
 * parse, the PUT validation — while publisher.ts owns the transport and is the
 * only thing that reads or writes the stored blob.
 *
 * Prompt templates are the user's, not the tool's: the list starts empty and
 * nothing is shipped as a default (see contract.ts for why), so there is also
 * no "built-in generation" to migrate between versions.
 *
 * The API key is stored in clear text, exactly like the publishing tool stores
 * its application password: both live in local files/databases on the same
 * machine and never travel to a browser — every read of the config by the
 * window redacts the key down to a boolean.
 */

/** Same data-dir convention as the publishing tool's database. */
export const dataDir = process.env.PUBLISHER_DATA ?? process.cwd();

/** The legacy file this configuration used to live in; imported once, never written. */
export const legacyConfigPath = `${dataDir}/intake.config.json`;

export type Provider = "openai" | "gemini";

export interface Template {
    id: string;
    label: string;
    /** Where the raw material for this type usually comes from — shown as a hint. */
    sourceHint: string;
    /** The system prompt: the user's craft rules plus the output contract. */
    prompt: string;
}

export interface LlmConfig {
    provider: Provider;
    /** "" = the provider's own default endpoint. */
    baseUrl: string;
    model: string;
    apiKey: string;
    /**
     * Reuse the publishing tool's HTTP proxy for the model call. Off = direct
     * connection; there is deliberately no separate proxy field, because one
     * machine needs one outbound route.
     */
    usePublisherProxy: boolean;
    temperature: number;
    /** Ask for a JSON response; a provider that refuses gets one retry without it. */
    jsonMode: boolean;
}

export interface IntakeConfig {
    llm: LlmConfig;
    /** Empty until the user writes one in the window. */
    templates: Template[];
}

export const DEFAULT_LLM: LlmConfig = {
    provider: "openai",
    baseUrl: "",
    model: "",
    apiKey: "",
    usePublisherProxy: true,
    temperature: 0.3,
    jsonMode: true,
};

export function defaultConfig(): IntakeConfig {
    return { llm: { ...DEFAULT_LLM }, templates: [] };
}

function asString(value: unknown, fallback: string): string {
    return typeof value === "string" ? value : fallback;
}

function asTemplate(value: unknown): Template | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const source = value as Record<string, unknown>;
    const id = asString(source.id, "").trim();
    const prompt = asString(source.prompt, "").trim();
    if (id === "" || prompt === "") {
        return null;
    }
    return {
        id: id.slice(0, 64),
        label: asString(source.label, id).trim().slice(0, 64) || id,
        sourceHint: asString(source.sourceHint, "").trim().slice(0, 500),
        prompt: prompt.slice(0, 20_000),
    };
}

/**
 * A stored blob → a usable config, never throwing: a hand-edited payload
 * degrades to the defaults field by field, because losing the window to a
 * stray comma would be worse than losing one setting. Templates are taken as
 * they are stored — nothing is injected, since the tool ships no presets — and
 * a payload with no templates at all is simply a configuration that has none
 * yet.
 */
export function parseConfig(raw: string | null): IntakeConfig {
    const fallback = defaultConfig();
    if (raw === null || raw.trim() === "") {
        return fallback;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return fallback;
    }
    return parseIntakeConfig(parsed, fallback);
}

/** The shared body of parseConfig and the legacy-file import. */
function parseIntakeConfig(parsed: unknown, fallback: IntakeConfig): IntakeConfig {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return fallback;
    }
    const source = parsed as Record<string, unknown>;
    const llmSource = (source.llm ?? {}) as Record<string, unknown>;
    const provider = llmSource.provider === "gemini" ? "gemini" : "openai";
    const temperature = typeof llmSource.temperature === "number" ? llmSource.temperature : fallback.llm.temperature;
    const templates = Array.isArray(source.templates)
        ? source.templates.map(asTemplate).filter((item): item is Template => item !== null)
        : [];

    return {
        llm: {
            provider,
            baseUrl: asString(llmSource.baseUrl, "").trim(),
            model: asString(llmSource.model, "").trim(),
            apiKey: asString(llmSource.apiKey, ""),
            usePublisherProxy: llmSource.usePublisherProxy !== false,
            temperature: Math.min(2, Math.max(0, temperature)),
            jsonMode: llmSource.jsonMode !== false,
        },
        templates,
    };
}

/** The stored form. One row, so the shape only has to survive a JSON round trip. */
export function serializeConfig(config: IntakeConfig): string {
    return JSON.stringify(config);
}

/**
 * The pre-database file's shape (it also carried publisherUrl, which is a
 * launch fact now and is ignored here). Returns null when the file has nothing
 * usable, so a broken leftover cannot block the move to the database.
 */
export function parseLegacyConfig(raw: string): IntakeConfig | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }
        const config = parseIntakeConfig(parsed, defaultConfig());
        const source = parsed as Record<string, unknown>;
        const llmSource = (source.llm ?? {}) as Record<string, unknown>;
        const hasKey = typeof llmSource.apiKey === "string" && llmSource.apiKey.trim() !== "";
        const hasTemplates = Array.isArray(source.templates) && source.templates.length > 0;
        return hasKey || hasTemplates ? config : null;
    } catch {
        return null;
    }
}

/** What the browser is allowed to see: the key becomes a boolean. */
export interface PublicConfig extends Omit<IntakeConfig, "llm"> {
    /** Where the publishing tool is, from the launch environment (read-only). */
    publisherUrl: string;
    llm: Omit<LlmConfig, "apiKey"> & { hasApiKey: boolean };
}

export function publicConfig(config: IntakeConfig, publisherUrl: string): PublicConfig {
    const { apiKey, ...rest } = config.llm;
    return { ...config, publisherUrl, llm: { ...rest, hasApiKey: apiKey.trim() !== "" } };
}

/** Field-by-field validation of a PUT payload; the current config fills the gaps. */
export function mergeConfigPayload(current: IntakeConfig, payload: unknown): { config: IntakeConfig; error: string | null } {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        return { config: current, error: "请求体必须是一个对象。" };
    }
    const source = payload as Record<string, unknown>;
    const next: IntakeConfig = {
        llm: { ...current.llm },
        templates: current.templates.map((item) => ({ ...item })),
    };
    // publisherUrl is accepted and ignored: it is set when this process is
    // launched, and the window shows it read-only.

    if (source.llm !== undefined) {
        if (source.llm === null || typeof source.llm !== "object" || Array.isArray(source.llm)) {
            return { config: current, error: "llm 必须是一个对象。" };
        }
        const llm = source.llm as Record<string, unknown>;
        if (llm.provider !== undefined) {
            if (llm.provider !== "openai" && llm.provider !== "gemini") {
                return { config: current, error: "provider 只能是 openai 或 gemini。" };
            }
            next.llm.provider = llm.provider;
        }
        if (llm.baseUrl !== undefined) {
            const value = asString(llm.baseUrl, "").trim().replace(/\/+$/, "");
            if (value !== "") {
                try {
                    new URL(value);
                } catch {
                    return { config: current, error: "baseUrl 不是合法地址。" };
                }
            }
            next.llm.baseUrl = value;
        }
        if (llm.model !== undefined) {
            next.llm.model = asString(llm.model, "").trim().slice(0, 128);
        }
        // An empty apiKey means "keep the stored one", the same way the
        // publisher treats an empty application password.
        if (llm.apiKey !== undefined && asString(llm.apiKey, "") !== "") {
            next.llm.apiKey = asString(llm.apiKey, "");
        }
        if (llm.usePublisherProxy !== undefined) {
            if (typeof llm.usePublisherProxy !== "boolean") {
                return { config: current, error: "usePublisherProxy 必须是布尔值。" };
            }
            next.llm.usePublisherProxy = llm.usePublisherProxy;
        }
        if (llm.temperature !== undefined) {
            if (typeof llm.temperature !== "number" || !Number.isFinite(llm.temperature)) {
                return { config: current, error: "temperature 必须是数字。" };
            }
            if (llm.temperature < 0 || llm.temperature > 2) {
                return { config: current, error: "temperature 必须在 0 到 2 之间。" };
            }
            next.llm.temperature = llm.temperature;
        }
        if (llm.jsonMode !== undefined) {
            if (typeof llm.jsonMode !== "boolean") {
                return { config: current, error: "jsonMode 必须是布尔值。" };
            }
            next.llm.jsonMode = llm.jsonMode;
        }
    }

    if (source.templates !== undefined) {
        if (!Array.isArray(source.templates)) {
            return { config: current, error: "templates 必须是数组。" };
        }
        // An empty array is a legitimate state — the tool ships no presets, so
        // "no templates yet" is where every fresh install starts — and it is
        // also how the window clears the list. Entries that carry no id or no
        // prompt are dropped rather than refused, the same tolerance the stored
        // blob gets.
        next.templates = source.templates.map(asTemplate).filter((item): item is Template => item !== null);
    }

    return { config: next, error: null };
}

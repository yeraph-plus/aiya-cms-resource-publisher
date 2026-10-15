/**
 * The intake process's own configuration. It deliberately does not touch the
 * publisher's database or its settings table: this file lives next to
 * publisher.db but holds only the intake window's business — where to post,
 * which model, and the prompt templates.
 *
 * The API key is stored here in clear text, exactly like the publisher's
 * application password is stored in its own database. It never travels to the
 * browser: the window asks this process to run the completion, and every read
 * of the config redacts the key down to a boolean.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_TEMPLATES, type Template } from "./templates.js";

/** Same data-dir convention as the publisher's database. */
const dataDir = process.env.PUBLISHER_DATA ?? process.cwd();
export const configPath = join(dataDir, "intake.config.json");

export type Provider = "openai" | "gemini";

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
    /** The publishing tool's fixed ingest entry. */
    publisherUrl: string;
    llm: LlmConfig;
    templates: Template[];
    /** Which built-in prompt generation is stored; see CURRENT_TEMPLATES_VERSION. */
    templatesVersion: number;
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

/**
 * Bumped when the built-in contracts change shape. A stored template with a
 * lower version is refreshed *only* while it still asks the model for the
 * fields the publisher owns nowadays (the old built-ins did, in their JSON
 * block and in a hard rule); a prompt somebody rewrote survives every upgrade.
 */
export const CURRENT_TEMPLATES_VERSION = 2;
const STALE_CONTRACT_MARKERS = ['"authorId"', "status 固定"];

export function defaultConfig(): IntakeConfig {
    return {
        publisherUrl: "http://127.0.0.1:5175",
        llm: { ...DEFAULT_LLM },
        templates: BUILTIN_TEMPLATES.map((item) => ({ ...item })),
        templatesVersion: CURRENT_TEMPLATES_VERSION,
    };
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
 * Never throws: a hand-edited or half-written file degrades to the defaults
 * field by field, because losing the window to a stray comma would be worse
 * than losing one setting.
 */
export function loadConfig(): IntakeConfig {
    const fallback = defaultConfig();
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
        return fallback;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return fallback;
    }

    const source = parsed as Record<string, unknown>;
    const llmSource = (source.llm ?? {}) as Record<string, unknown>;
    const provider = llmSource.provider === "gemini" ? "gemini" : "openai";
    const temperature = typeof llmSource.temperature === "number" ? llmSource.temperature : fallback.llm.temperature;
    const stored = Array.isArray(source.templates)
        ? source.templates.map(asTemplate).filter((item): item is Template => item !== null)
        : [];
    // An empty saved list means "use the built-ins", not "no templates".
    const templates = stored.length > 0 ? stored : fallback.templates;
    const version = typeof source.templatesVersion === "number" ? source.templatesVersion : 1;

    return {
        publisherUrl: asString(source.publisherUrl, fallback.publisherUrl).trim() || fallback.publisherUrl,
        llm: {
            provider,
            baseUrl: asString(llmSource.baseUrl, "").trim(),
            model: asString(llmSource.model, "").trim(),
            apiKey: asString(llmSource.apiKey, ""),
            usePublisherProxy: llmSource.usePublisherProxy !== false,
            temperature: Math.min(2, Math.max(0, temperature)),
            jsonMode: llmSource.jsonMode !== false,
        },
        templates: version < CURRENT_TEMPLATES_VERSION ? refreshStaleBuiltins(templates, fallback.templates) : templates,
        templatesVersion: CURRENT_TEMPLATES_VERSION,
    };
}

/**
 * Upgrades the built-in prompts in place. A prompt the user rewrote is left
 * alone — the markers only survive in a template that still declares author and
 * status as outputs, which is exactly what the old built-ins did.
 */
function refreshStaleBuiltins(stored: Template[], builtins: Template[]): Template[] {
    return stored.map((template) => {
        const builtin = builtins.find((item) => item.id === template.id);
        const stale = STALE_CONTRACT_MARKERS.every((marker) => template.prompt.includes(marker));
        return builtin && stale ? { ...builtin } : template;
    });
}

export function saveConfig(config: IntakeConfig): void {
    writeFileSync(configPath, `${JSON.stringify(config, null, 4)}\n`, "utf8");
}

/** What the browser is allowed to see: the key becomes a boolean. */
export interface PublicConfig extends Omit<IntakeConfig, "llm"> {
    llm: Omit<LlmConfig, "apiKey"> & { hasApiKey: boolean };
}

export function publicConfig(config: IntakeConfig): PublicConfig {
    const { apiKey, ...rest } = config.llm;
    return { ...config, llm: { ...rest, hasApiKey: apiKey.trim() !== "" } };
}

/** Field-by-field validation of a PUT payload; the current config fills the gaps. */
export function mergeConfigPayload(current: IntakeConfig, payload: unknown): { config: IntakeConfig; error: string | null } {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        return { config: current, error: "请求体必须是一个对象。" };
    }
    const source = payload as Record<string, unknown>;
    const next: IntakeConfig = {
        publisherUrl: current.publisherUrl,
        llm: { ...current.llm },
        templates: current.templates.map((item) => ({ ...item })),
        templatesVersion: current.templatesVersion,
    };

    if (source.publisherUrl !== undefined) {
        const value = asString(source.publisherUrl, "").trim();
        if (value === "") {
            return { config: current, error: "publisherUrl 不能为空。" };
        }
        try {
            const parsed = new URL(value);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                return { config: current, error: "publisherUrl 必须是 http(s) 地址。" };
            }
        } catch {
            return { config: current, error: "publisherUrl 不是合法地址。" };
        }
        next.publisherUrl = value.replace(/\/+$/, "");
    }

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
        const parsed = source.templates.map(asTemplate).filter((item): item is Template => item !== null);
        if (parsed.length === 0) {
            return { config: current, error: "至少要保留一个提示词模板。" };
        }
        next.templates = parsed;
        // Whatever the window saves is the current generation by definition.
        next.templatesVersion = CURRENT_TEMPLATES_VERSION;
    }

    return { config: next, error: null };
}
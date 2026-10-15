/**
 * Two model transports, and only two: an OpenAI-compatible
 * /chat/completions and a Gemini generateContent. The window never sees the
 * key — it asks this process to run the completion, so the credential stays in
 * the config file and out of the browser.
 *
 * The call is a plain request/response pair. There is no agent loop, no tool
 * use and no streaming: one corpus in, one JSON answer out.
 */

import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";
import type { LlmConfig } from "./config.js";

export class LlmError extends Error {
    readonly status: number | null;

    constructor(message: string, status: number | null = null) {
        super(message);
        this.name = "LlmError";
        this.status = status;
    }
}

export interface Completion {
    text: string;
    model: string;
    usage: unknown;
}

/** A long corpus plus a slow model: generous, but not unbounded. */
const TIMEOUT_MS = 180_000;

const DEFAULT_BASE: Record<LlmConfig["provider"], string> = {
    openai: "https://api.openai.com/v1",
    gemini: "https://generativelanguage.googleapis.com",
};

/** One agent per proxy endpoint, reused across requests. */
const proxyAgents = new Map<string, ProxyAgent>();

function proxyDispatcher(proxyUrl: string): Dispatcher | undefined {
    let raw = proxyUrl.trim();
    if (raw === "") {
        return undefined;
    }
    if (!/^https?:\/\//i.test(raw)) {
        raw = `http://${raw}`;
    }
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new LlmError(`代理地址无法解析：${proxyUrl}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new LlmError(`代理仅支持 http(s)://，不支持 ${parsed.protocol}（SOCKS 需在代理客户端开 HTTP/mixed 端口）。`);
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

function snippet(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat || "（空响应）";
}

/** One HTTP round trip; transport failures and timeouts surface as LlmError. */
async function request(url: string, init: Parameters<typeof undiciFetch>[1], proxyUrl: string): Promise<Awaited<ReturnType<typeof undiciFetch>>> {
    const dispatcher = proxyDispatcher(proxyUrl);
    try {
        return await undiciFetch(url, {
            ...init,
            ...(dispatcher ? { dispatcher } : {}),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (error) {
        throw new LlmError(`请求模型接口失败：${error instanceof Error ? error.message : String(error)}`);
    }
}

interface OpenAiResponse {
    model?: unknown;
    usage?: unknown;
    choices?: { message?: { content?: unknown } }[];
}

async function openai(
    config: LlmConfig,
    base: string,
    system: string,
    user: string,
    jsonMode: boolean,
    proxyUrl: string,
): Promise<Completion> {
    const body: Record<string, unknown> = {
        model: config.model,
        messages: [
            { role: "system", content: system },
            { role: "user", content: user },
        ],
        temperature: config.temperature,
    };
    if (jsonMode) {
        body.response_format = { type: "json_object" };
    }

    const response = await request(
        `${base}/chat/completions`,
        {
            method: "POST",
            headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify(body),
        },
        proxyUrl,
    );

    if (!response.ok) {
        const text = await response.text();
        // Many OpenAI-compatible servers do not implement JSON mode; a 400
        // that names the field is that, not a bad request from us.
        if (jsonMode && response.status === 400 && /response_format/i.test(text)) {
            return openai(config, base, system, user, false, proxyUrl);
        }
        throw new LlmError(`模型接口返回 ${response.status}：${snippet(text)}`, response.status);
    }

    const payload = (await response.json()) as OpenAiResponse;
    const text = payload.choices?.[0]?.message?.content;
    if (typeof text !== "string" || text.trim() === "") {
        throw new LlmError("模型没有返回内容。");
    }
    return { text, model: typeof payload.model === "string" ? payload.model : config.model, usage: payload.usage ?? null };
}

interface GeminiResponse {
    modelVersion?: unknown;
    usageMetadata?: unknown;
    candidates?: { content?: { parts?: { text?: unknown }[] } }[];
}

async function gemini(
    config: LlmConfig,
    base: string,
    system: string,
    user: string,
    jsonMode: boolean,
    proxyUrl: string,
): Promise<Completion> {
    const generationConfig: Record<string, unknown> = { temperature: config.temperature };
    if (jsonMode) {
        generationConfig.responseMimeType = "application/json";
    }
    const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig,
    };

    const response = await request(
        `${base}/v1beta/models/${encodeURIComponent(config.model)}:generateContent`,
        {
            method: "POST",
            headers: { "x-goog-api-key": config.apiKey, "content-type": "application/json" },
            body: JSON.stringify(body),
        },
        proxyUrl,
    );

    if (!response.ok) {
        const text = await response.text();
        if (jsonMode && response.status === 400 && /responseMimeType|response_mime_type/i.test(text)) {
            return gemini(config, base, system, user, false, proxyUrl);
        }
        throw new LlmError(`模型接口返回 ${response.status}：${snippet(text)}`, response.status);
    }

    const payload = (await response.json()) as GeminiResponse;
    const parts = payload.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((part) => (typeof part.text === "string" ? part.text : "")).join("");
    if (text.trim() === "") {
        throw new LlmError("模型没有返回内容。");
    }
    return {
        text,
        model: typeof payload.modelVersion === "string" ? payload.modelVersion : config.model,
        usage: payload.usageMetadata ?? null,
    };
}

/**
 * One completion. `proxyUrl` is resolved by the caller (the window decides
 * between reusing the publishing tool's proxy and going direct), so this module
 * never reaches for configuration it was not handed.
 */
export async function complete(config: LlmConfig, proxyUrl: string, system: string, user: string): Promise<Completion> {
    if (config.model.trim() === "") {
        throw new LlmError("还没配置模型名：在摄取窗口的配置卡片里填，或写进 intake.config.json。");
    }
    if (config.apiKey.trim() === "") {
        throw new LlmError("还没配置 API 密钥：在摄取窗口的配置卡片里填。");
    }
    const base = (config.baseUrl.trim() === "" ? DEFAULT_BASE[config.provider] : config.baseUrl.trim()).replace(/\/+$/, "");
    return config.provider === "gemini"
        ? gemini(config, base, system, user, config.jsonMode, proxyUrl)
        : openai(config, base, system, user, config.jsonMode, proxyUrl);
}
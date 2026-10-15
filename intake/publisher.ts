/**
 * Everything this process does with the publishing tool: the configuration blob
 * it stores for us, the ingest contract, and the proxy address the model call
 * may reuse.
 *
 * The tool's address is a launch fact (PUBLISHER_URL, default
 * http://127.0.0.1:5175) and not part of the configuration, because the
 * configuration *lives on the other side of that connection* — reading it is
 * the one thing that needs the address up front. The desktop shell passes it
 * explicitly; a repo-side `npm run intake` uses the default.
 *
 * Reads and writes go through a real HTTP call rather than opening the database
 * directly: better-sqlite3 would drag a native module (and its Electron-vs-Node
 * ABI) into a process that otherwise needs neither.
 */

import { readFileSync } from "node:fs";
import { fetch as undiciFetch } from "undici";
import {
    defaultConfig,
    legacyConfigPath,
    parseConfig,
    parseLegacyConfig,
    serializeConfig,
    type IntakeConfig,
} from "./config.js";
import { LlmError } from "./llm.js";

export const publisherUrl = (process.env.PUBLISHER_URL ?? "http://127.0.0.1:5175").replace(/\/+$/, "");

const CONFIG_PATH = "/api/intake/config";

/** Forward one call to the publishing tool and hand its answer back verbatim. */
export async function callPublisher(
    path: string,
    init: { method: "GET" | "PUT" | "POST"; body?: unknown } = { method: "GET" },
): Promise<{ status: number; body: unknown }> {
    const url = `${publisherUrl}${path}`;
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
        response = await undiciFetch(url, {
            method: init.method,
            headers: { "content-type": "application/json" },
            ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
            signal: AbortSignal.timeout(60_000),
        });
    } catch (error) {
        throw new LlmError(`连不上发帖器（${url}）：${error instanceof Error ? error.message : String(error)}。发帖器在跑吗？`);
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
        parsed = text === "" ? null : JSON.parse(text);
    } catch {
        parsed = { error: `发帖器返回了非 JSON 内容：${text.slice(0, 300)}` };
    }
    return { status: response.status, body: parsed };
}

/** The tool's own error text, for a message a human can act on. */
function errorOf(answer: { body: unknown }): string {
    const body = answer.body;
    if (body !== null && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
        return `：${(body as { error: string }).error}`;
    }
    return "";
}

/**
 * The stored configuration. Nothing stored yet means a repository-side
 * intake.config.json from before the database became the store is imported
 * exactly once — an existing model key and prompt edits survive the move, and
 * the file is left where it is rather than deleted.
 */
export async function loadConfig(): Promise<IntakeConfig> {
    const answer = await callPublisher(CONFIG_PATH);
    if (answer.status !== 200) {
        throw new LlmError(`读不到摄取配置：发帖器返回 ${answer.status}${errorOf(answer)}`);
    }
    const payload = (answer.body as { payload?: unknown } | null)?.payload;
    if (typeof payload === "string" && payload.trim() !== "") {
        return parseConfig(payload);
    }
    const legacy = readLegacyConfig();
    if (legacy !== null) {
        await saveConfig(legacy);
        return legacy;
    }
    return defaultConfig();
}

export async function saveConfig(config: IntakeConfig): Promise<void> {
    const answer = await callPublisher(CONFIG_PATH, { method: "PUT", body: { payload: serializeConfig(config) } });
    if (answer.status !== 200) {
        throw new LlmError(`保存摄取配置失败：发帖器返回 ${answer.status}${errorOf(answer)}`);
    }
}

/** Null when there is no legacy file, or nothing usable in it. */
function readLegacyConfig(): IntakeConfig | null {
    try {
        return parseLegacyConfig(readFileSync(legacyConfigPath, "utf8"));
    } catch {
        return null;
    }
}

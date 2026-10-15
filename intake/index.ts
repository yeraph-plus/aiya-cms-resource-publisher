/**
 * 智能摄取窗口 — an isolated local process with its own window, its own
 * configuration and its own model credentials. It shares nothing with the
 * publishing tool except the pure taxonomy registry and the one HTTP contract
 * the tool publishes: /api/ingest.
 *
 * Two reasons it is a separate process rather than a tab in the publisher:
 * the publisher then keeps zero model code and zero keys, and a model provider
 * change (or a broken prompt) cannot take the push queue down with it.
 *
 * It listens on 127.0.0.1:5180 and refuses anything else. The window talks
 * only to this origin — publisher calls are re-issued from here, so no CORS
 * exception has to exist on the publisher side and the browser never sees the
 * publisher's address or this process's key.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { fetch as undiciFetch } from "undici";
import { loadConfig, mergeConfigPayload, publicConfig, saveConfig, type IntakeConfig } from "./config.js";
import { complete, LlmError } from "./llm.js";
import { extractJson, toDraft } from "./parse.js";
import { buildUserMessage, type Vocabulary } from "./prompt.js";

const PORT = Number(process.env.INTAKE_PORT ?? 5180);
const HOST = "127.0.0.1";
/** One corpus plus the vocabulary; text only, and nothing here is an image. */
const BODY_LIMIT = 4 * 1024 * 1024;
/** Beyond this the prompt is mostly the corpus and the model starts losing the rules. */
const CORPUS_LIMIT = 200_000;

const pagePath = fileURLToPath(new URL("./page.html", import.meta.url));
const page = readFileSync(pagePath, "utf8");

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function hostnameOf(value: string | undefined): string | null {
    if (value === undefined || value === "") {
        return null;
    }
    try {
        return new URL(value.includes("://") ? value : `http://${value}`).hostname;
    } catch {
        return null;
    }
}

function normalizeVocabulary(value: unknown): Vocabulary {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    const result: Vocabulary = {};
    for (const [taxonomy, list] of Object.entries(value as Record<string, unknown>)) {
        if (!Array.isArray(list)) {
            continue;
        }
        const entries = list
            .map((item) => {
                if (item === null || typeof item !== "object") {
                    return null;
                }
                const source = item as Record<string, unknown>;
                const name = typeof source.name === "string" ? source.name.trim() : "";
                if (name === "") {
                    return null;
                }
                const path = typeof source.path === "string" ? source.path.trim() : "";
                return {
                    name,
                    count: typeof source.count === "number" && Number.isFinite(source.count) ? source.count : 0,
                    // The publisher publishes a hierarchical 分类 as "父 / 子";
                    // keeping it means the prompt names the exact branch.
                    ...(path !== "" ? { path } : {}),
                };
            })
            .filter((item): item is { name: string; count: number; path?: string } => item !== null);
        if (entries.length > 0) {
            result[taxonomy] = entries;
        }
    }
    return result;
}

/** Forward one call to the publishing tool and hand its answer back verbatim. */
async function callPublisher(
    config: IntakeConfig,
    path: string,
    init: { method: "GET" | "POST"; body?: unknown } = { method: "GET" },
): Promise<{ status: number; body: unknown }> {
    const url = `${config.publisherUrl.replace(/\/+$/, "")}${path}`;
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

async function main(): Promise<void> {
    const app = Fastify({ bodyLimit: BODY_LIMIT, logger: { level: "info" } });

    // Local-only, the same way the publishing tool guards itself: this process
    // holds an API key and can spend money, so it is not a network service.
    app.addHook("onRequest", async (request, reply) => {
        const host = hostnameOf(request.headers.host);
        if (host === null || !LOCAL_HOSTS.has(host)) {
            return reply.code(403).send({ error: "摄取窗口只接受本机访问。" });
        }
        const origin = request.headers.origin;
        if (origin !== undefined && !LOCAL_HOSTS.has(hostnameOf(origin) ?? "")) {
            return reply.code(403).send({ error: "摄取窗口只接受本机来源。" });
        }
    });

    app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(page));

    app.get("/api/health", async () => ({ ok: true, port: PORT, publisherUrl: loadConfig().publisherUrl }));

    app.get("/api/config", async () => publicConfig(loadConfig()));

    app.put("/api/config", async (request, reply) => {
        const merged = mergeConfigPayload(loadConfig(), request.body);
        if (merged.error !== null) {
            return reply.code(400).send({ error: merged.error });
        }
        saveConfig(merged.config);
        app.log.info({ publisherUrl: merged.config.publisherUrl, model: merged.config.llm.model }, "配置已保存");
        return publicConfig(merged.config);
    });

    // --- the publishing tool's contract, re-issued from this origin ----------
    app.get("/api/publisher/context", async (_request, reply) => {
        const answer = await callPublisher(loadConfig(), "/api/ingest/context");
        return reply.code(answer.status).send(answer.body);
    });

    app.post("/api/publisher/preview", async (request, reply) => {
        const answer = await callPublisher(loadConfig(), "/api/ingest/preview", { method: "POST", body: request.body ?? {} });
        return reply.code(answer.status).send(answer.body);
    });

    app.post("/api/publisher/ingest", async (request, reply) => {
        const answer = await callPublisher(loadConfig(), "/api/ingest", { method: "POST", body: request.body ?? {} });
        return reply.code(answer.status).send(answer.body);
    });

    /**
     * The proxy the model call uses. Sharing is the default and the value lives
     * in the publishing tool, so it is read per call instead of cached — the
     * window is where it gets edited. An unreachable tool falls back to a
     * direct connection with a log line rather than failing the completion:
     * the user asked for a draft, not for a proxy.
     */
    const resolveProxy = async (config: IntakeConfig): Promise<{ proxyUrl: string; note: string }> => {
        if (!config.llm.usePublisherProxy) {
            return { proxyUrl: "", note: "直连" };
        }
        try {
            const answer = await callPublisher(config, "/api/ingest/context");
            const body = answer.body;
            const proxyUrl =
                answer.status === 200 && body !== null && typeof body === "object" && typeof (body as { proxyUrl?: unknown }).proxyUrl === "string"
                    ? (body as { proxyUrl: string }).proxyUrl.trim()
                    : "";
            return { proxyUrl, note: proxyUrl === "" ? "直连（发帖器未设代理）" : `共用发帖器代理：${proxyUrl}` };
        } catch (error) {
            app.log.warn(
                { error: error instanceof Error ? error.message : String(error) },
                "读发帖器的代理设置失败，这次按直连处理",
            );
            return { proxyUrl: "", note: "直连（读发帖器代理失败）" };
        }
    };

    // --- one corpus in, one structured draft out -----------------------------
    app.post("/api/generate", async (request, reply) => {
        const config = loadConfig();
        const body = (request.body ?? {}) as { corpus?: unknown; templateId?: unknown; vocabulary?: unknown };

        const corpus = typeof body.corpus === "string" ? body.corpus.trim() : "";
        if (corpus === "") {
            return reply.code(400).send({ error: "先贴一段原始语料。" });
        }
        if (corpus.length > CORPUS_LIMIT) {
            return reply.code(400).send({ error: `语料太长（${corpus.length} 字，上限 ${CORPUS_LIMIT} 字）：只贴与这一条相关的部分。` });
        }

        const templateId = typeof body.templateId === "string" ? body.templateId : "";
        const template = config.templates.find((item) => item.id === templateId) ?? config.templates[0];
        if (template === undefined) {
            return reply.code(500).send({ error: "配置里一个提示词模板都没有。" });
        }

        const user = buildUserMessage(corpus, normalizeVocabulary(body.vocabulary));
        const proxy = await resolveProxy(config);
        app.log.info(
            { template: template.id, model: config.llm.model, corpus: corpus.length, proxy: proxy.note },
            "开始生成",
        );

        try {
            const completion = await complete(config.llm, proxy.proxyUrl, template.prompt, user);
            const json = extractJson(completion.text);
            if (!json.ok) {
                app.log.warn({ model: completion.model }, "模型返回不是 JSON");
                return reply.code(502).send({ error: json.error, raw: completion.text, model: completion.model });
            }
            const draft = toDraft(json.value);
            if (!draft.ok) {
                app.log.warn({ model: completion.model }, "模型返回缺少字段");
                return reply.code(502).send({ error: draft.error, raw: completion.text, model: completion.model });
            }
            app.log.info({ model: completion.model, title: draft.value.title }, "生成完成");
            return {
                draft: draft.value,
                templateId: template.id,
                model: completion.model,
                usage: completion.usage,
                proxy: proxy.note,
                raw: completion.text,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            app.log.error({ error: message }, "生成失败");
            return reply.code(502).send({ error: message });
        }
    });

    app.setErrorHandler(async (error: Error & { statusCode?: number }, request, reply) => {
        const status = error instanceof LlmError ? 502 : (error.statusCode ?? 500);
        request.log.error({ error: error.message }, "请求失败");
        return reply.code(status).send({ error: error.message });
    });

    try {
        await app.listen({ host: HOST, port: PORT });
        app.log.info(`摄取窗口：http://${HOST}:${PORT}`);
    } catch (error) {
        if ((error as { code?: string }).code === "EADDRINUSE") {
            app.log.error(`端口 ${PORT} 已被占用：先关掉旧的摄取窗口，或用 INTAKE_PORT 换端口。`);
            process.exit(1);
        }
        throw error;
    }

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => {
            void app.close().then(() => process.exit(0));
        });
    }
}

await main();
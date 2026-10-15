/**
 * 智能摄取窗口 — an isolated local process with its own window and its own
 * model credentials. It shares the pure taxonomy registry and the HTTP contract
 * the publishing tool publishes: /api/ingest, plus /api/intake/config, which is
 * where its own configuration is stored (one row in the tool's database, so the
 * packaged app has a single data store).
 *
 * Two reasons it is a separate process rather than a tab in the publisher:
 * no model code and no model call lives in the push queue's process, and a
 * model provider change (or a broken prompt) cannot take publishing down with
 * it.
 *
 * It listens on 127.0.0.1:5180 and refuses anything else. The window talks
 * only to this origin — publisher calls are re-issued from here, so no CORS
 * exception has to exist on the publisher side and the browser never sees the
 * publisher's address or this process's key.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { mergeConfigPayload, publicConfig, type IntakeConfig } from "./config.js";
import { OUTPUT_CONTRACT } from "./contract.js";
import { complete, LlmError } from "./llm.js";
import { extractJson, toDraft } from "./parse.js";
import { buildUserMessage, type Vocabulary } from "./prompt.js";
import { callPublisher, loadConfig, publisherUrl, saveConfig } from "./publisher.js";

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

    // The address is a launch fact, so health answers without touching the
    // tool: the window can always show where this process points.
    app.get("/api/health", async () => ({ ok: true, port: PORT, publisherUrl }));

    // The one piece of prompt text the tool owns: the JSON shape the model must
    // answer with. The window offers it as "插入输出契约" so a self-written
    // template can be completed without copying it out of a doc.
    app.get("/api/output-contract", async () => ({ contract: OUTPUT_CONTRACT }));

    app.get("/api/config", async () => publicConfig(await loadConfig(), publisherUrl));

    app.put("/api/config", async (request, reply) => {
        const merged = mergeConfigPayload(await loadConfig(), request.body);
        if (merged.error !== null) {
            return reply.code(400).send({ error: merged.error });
        }
        await saveConfig(merged.config);
        app.log.info({ publisherUrl, model: merged.config.llm.model }, "配置已保存");
        return publicConfig(merged.config, publisherUrl);
    });

    // --- the publishing tool's contract, re-issued from this origin ----------
    app.get("/api/publisher/context", async (_request, reply) => {
        const answer = await callPublisher("/api/ingest/context");
        return reply.code(answer.status).send(answer.body);
    });

    app.post("/api/publisher/preview", async (request, reply) => {
        const answer = await callPublisher("/api/ingest/preview", { method: "POST", body: request.body ?? {} });
        return reply.code(answer.status).send(answer.body);
    });

    app.post("/api/publisher/ingest", async (request, reply) => {
        const answer = await callPublisher("/api/ingest", { method: "POST", body: request.body ?? {} });
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
            const answer = await callPublisher("/api/ingest/context");
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
        const config = await loadConfig();
        const body = (request.body ?? {}) as { corpus?: unknown; templateId?: unknown; vocabulary?: unknown };

        const corpus = typeof body.corpus === "string" ? body.corpus.trim() : "";
        if (corpus === "") {
            return reply.code(400).send({ error: "先贴一段原始语料。" });
        }
        if (corpus.length > CORPUS_LIMIT) {
            return reply.code(400).send({ error: `语料太长（${corpus.length} 字，上限 ${CORPUS_LIMIT} 字）：只贴与这一条相关的部分。` });
        }

        const templateId = typeof body.templateId === "string" ? body.templateId : "";
        // No presets ship with the tool, so "no templates yet" is a normal
        // first-run state and says what to do about it.
        if (config.templates.length === 0) {
            return reply
                .code(400)
                .send({ error: "还没有提示词模板：在配置卡片里「新建模板」写一份（可点「插入输出契约」补上必需的 JSON 契约）再生成。" });
        }
        const template = config.templates.find((item) => item.id === templateId) ?? config.templates[0];
        if (template === undefined) {
            return reply.code(400).send({ error: `找不到模板「${templateId}」。` });
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
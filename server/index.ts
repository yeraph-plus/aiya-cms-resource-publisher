import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";
import {
    clearLogs,
    dbPath,
    deletePost,
    getPost,
    getSettings,
    getTermRefs,
    importPosts,
    insertPost,
    listAuthors,
    listLogs,
    listPosts,
    listTerms,
    logEvent,
    parseSnapshot,
    setSetting,
    setTermRefs,
    updatePostRow,
    type PostRow,
} from "./db.js";
import { runSync } from "./sync.js";
import { runPush } from "./push.js";
import { coerceDirNameMode, generateSink, listSinks, parseTemplate } from "./carrier.js";
import { runCompletionPush } from "./completion.js";
import { isOurStateEndpoint, killTree, listenerPid } from "./portguard.js";
import { getProgress, setProgress } from "./progress.js";
import { getResource, normalizeSiteUrl, parseSlugFromLink, ping, WpError } from "./wp.js";
import { parseCsv } from "../shared/csv.js";
import { buildImportRows, guessMapping, TAXONOMY_ORDER, type ImportMapping } from "../shared/import.js";
import { normalizeConfig } from "../shared/fileserve.js";

export async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });

    // One corrupt fileserve blob (a hand-edited db, an interrupted write)
    // must not take the whole state endpoint down.
    const parseFileserve = (raw: string | null): unknown => {
        if (!raw) {
            return null;
        }
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    };

    const rowWithTerms = (saved: PostRow) => ({
        ...saved,
        terms: getTermRefs(saved.localId),
        fileserveParsed: parseFileserve(saved.fileserve),
    });

function errorMessage(error: unknown): string {
    if (error instanceof WpError) {
        return `HTTP ${error.status}：${error.message}`;
    }
    return String(error);
}

    app.get("/api/state", async () => {
    const settings = getSettings();
    const grouped: Record<string, { id: number; name: string; slug: string }[]> = {};
    for (const term of listTerms()) {
        (grouped[term.taxonomy] ??= []).push({ id: term.id, name: term.name, slug: term.slug });
    }
    // Group terms per taxonomy in the fixed registry order (category first).
    const terms: Record<string, { id: number; name: string; slug: string }[]> = {};
    for (const slug of TAXONOMY_ORDER) {
        if (grouped[slug]) {
            terms[slug] = grouped[slug] as { id: number; name: string; slug: string }[];
        }
    }

        return {
            settings: {
                siteUrl: settings.siteUrl,
                username: settings.username,
                hasPassword: settings.appPassword !== "",
                proxyUrl: settings.proxyUrl,
                defaultAuthorId: settings.defaultAuthorId,
                lastSyncCursor: settings.lastSyncCursor,
                workRoot: settings.workRoot,
                dirNameMode: settings.dirNameMode,
                fileserveTemplate: settings.fileserveTemplate,
            },
            authors: listAuthors(),
            terms,
            posts: listPosts().map(rowWithTerms),
        };
});

    app.put("/api/settings", async (request, reply) => {
        const body = request.body as Record<string, unknown>;
        if (body.siteUrl !== undefined) {
            setSetting("siteUrl", normalizeSiteUrl(String(body.siteUrl ?? "")));
        }
        if (body.username !== undefined) {
            setSetting("username", String(body.username ?? "").trim());
        }
        if (typeof body.appPassword === "string" && body.appPassword.trim() !== "") {
            setSetting("appPassword", body.appPassword.trim());
        }
        if (body.proxyUrl !== undefined) {
            setSetting("proxyUrl", String(body.proxyUrl ?? "").trim());
        }
        if (body.defaultAuthorId !== undefined) {
            setSetting("defaultAuthorId", body.defaultAuthorId === null ? null : String(body.defaultAuthorId));
        }
        if (body.workRoot !== undefined) {
            setSetting("workRoot", String(body.workRoot ?? "").trim());
        }
        if (body.dirNameMode !== undefined) {
            const mode = String(body.dirNameMode);
            if (!["id", "id-slug", "slug"].includes(mode)) {
                return reply.code(400).send({ error: "目录命名模式无效。" });
            }
            setSetting("dirNameMode", mode);
        }
        if (body.fileserveTemplate !== undefined) {
            const raw = body.fileserveTemplate === null ? null : String(body.fileserveTemplate);
            if (raw !== null) {
                const template = parseTemplate(raw);
                if (template.error !== null) {
                    return reply.code(400).send({ error: template.error });
                }
            }
            setSetting("fileserveTemplate", raw);
        }
        return reply.code(200).send({ ok: true });
    });

    // The probe builds its credentials from the stored settings, then layers
    // whatever the form currently holds on top — so "测试连接" tests the
    // typed values without saving them.
    app.post("/api/connect", async (request) => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const settings = getSettings();
        const candidate = {
            siteUrl: body.siteUrl !== undefined ? normalizeSiteUrl(String(body.siteUrl ?? "")) : settings.siteUrl,
            username: body.username !== undefined ? String(body.username ?? "").trim() : settings.username,
            appPassword:
                typeof body.appPassword === "string" && body.appPassword.trim() !== ""
                    ? body.appPassword.trim()
                    : settings.appPassword,
            proxyUrl: body.proxyUrl !== undefined ? String(body.proxyUrl ?? "").trim() : settings.proxyUrl,
        };
        if (!candidate.siteUrl || !candidate.username || !candidate.appPassword) {
            return { ok: false, error: "先填好站点地址、用户名和应用密码。" };
        }
        try {
            const probe = await ping(candidate);
            if (!probe.resourceAvailable) {
                return { ok: false, error: "站点上没有 resource 文章类型（aiya-core 未启用？）。" };
            }
            return { ok: true, ping: probe };
        } catch (error) {
            return { ok: false, error: errorMessage(error) };
        }
    });

    app.post("/api/posts", async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const settings = getSettings();
    const localId = insertPost({
        status: "draft",
        title: String(body.title ?? "未命名资源"),
        authorId: settings.defaultAuthorId,
        dirty: true,
        lastSyncedGmt: null,
    });
    return { localId };
});

    app.put("/api/posts/:id", async (request, reply) => {
    const localId = Number((request.params as { id: string }).id);
    const row = getPost(localId);
    if (!row) {
        return reply.code(404).send({ error: "本地行不存在。" });
    }
    const body = request.body as Record<string, unknown>;

    // fileserve: null = the tool has no data for this row (leave the online
    // meta alone); an object — even an empty one — is the row's whole config,
    // so {} means "clear the online file lists on push".
    const { config, errors } = normalizeConfig(body.fileserve ?? null);
    if (errors.length > 0) {
        return reply.code(400).send({ error: errors.join(" ") });
    }
    const providesFileserve = body.fileserve !== null && body.fileserve !== undefined;
    const fileserve = providesFileserve
        ? Object.keys(config).length > 0
            ? JSON.stringify(config)
            : "{}"
        : row.fileserve;

    // Partial patches (a grid cell edit) must not touch the author: only an
    // explicit value (or an explicit null = "site default") changes it.
    const parsedAuthorId =
        body.authorId === undefined
            ? row.authorId
            : body.authorId === null || body.authorId === ""
                ? null
                : Number(body.authorId);
    if (parsedAuthorId !== null && !Number.isInteger(parsedAuthorId)) {
        return reply.code(400).send({ error: "作者必须是数字 id。" });
    }
    if (
        body.dateLocal !== undefined &&
        body.dateLocal !== "" &&
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(String(body.dateLocal))
    ) {
        return reply.code(400).send({ error: "发布时间格式无效。" });
    }

    const next = {
        status: String(body.status ?? row.status),
        title: String(body.title ?? row.title),
        content: String(body.content ?? row.content),
        authorId: parsedAuthorId,
        dateLocal: String(body.dateLocal ?? row.dateLocal),
        fileserve,
    };
    if (!["publish", "draft", "future"].includes(next.status)) {
        return reply.code(400).send({ error: "状态只能是 publish、draft 或 future。" });
    }

    // Terms ride along only when the client sent them: partial patches (a
    // grid cell edit) must not wipe the row's term references.
    const nextTerms = body.terms !== null && body.terms !== undefined && typeof body.terms === "object"
        ? (body.terms as Record<string, string[]>)
        : null;
    const canonicalRefs = (refs: Record<string, string[]>): string =>
        Object.entries(refs)
            .map(([taxonomy, list]) => `${taxonomy}:${[...list].sort().join(",")}`)
            .sort()
            .join("|");
    const termsChanged = nextTerms !== null && canonicalRefs(nextTerms) !== canonicalRefs(getTermRefs(localId));

    const changed =
        next.status !== row.status ||
        next.title !== row.title ||
        next.content !== row.content ||
        next.authorId !== row.authorId ||
        next.dateLocal !== row.dateLocal ||
        next.fileserve !== row.fileserve ||
        termsChanged;

    updatePostRow(localId, { ...next, dirty: changed ? true : row.dirty });
    if (nextTerms !== null) {
        setTermRefs(localId, nextTerms);
    }

    const saved = getPost(localId);
    return {
        row: saved ? rowWithTerms(saved) : null,
    };
});

    app.delete("/api/posts/:id", async (request) => {
    deletePost(Number((request.params as { id: string }).id));
    return { ok: true };
});

    app.post("/api/posts/:id/revert", async (request, reply) => {
    const localId = Number((request.params as { id: string }).id);
    const row = getPost(localId);
    if (!row) {
        return reply.code(404).send({ error: "本地行不存在。" });
    }
    const snapshot = parseSnapshot(row.snapshot);
    if (!snapshot) {
        return reply.code(400).send({ error: "这一行还没有已确认的快照可还原。" });
    }
    updatePostRow(localId, {
        status: snapshot.status,
        title: snapshot.title,
        content: snapshot.content,
        authorId: snapshot.authorId,
        dateLocal: snapshot.dateLocal,
        dateGmt: snapshot.dateGmt,
        modifiedGmt: snapshot.modifiedGmt,
        fileserve: snapshot.fileserve ? JSON.stringify(snapshot.fileserve) : null,
        dirty: false,
        conflict: false,
        lastError: null,
    });
    setTermRefs(localId, snapshot.terms);
    return { ok: true };
});

    // CSV import, two stateless steps: the client sends the raw file text
    // twice (preview, then apply) instead of the server holding parsed
    // state. Parsing, mapping guesses and row validation all live in
    // shared/import.ts — the client reruns the same pure code for its live
    // preview, so the counts it shows are the counts the apply writes.
    app.post("/api/import/preview", async (request, reply) => {
        const body = (request.body ?? {}) as { csv?: unknown };
        if (typeof body.csv !== "string" || body.csv.trim() === "") {
            return reply.code(400).send({ error: "没有收到 CSV 文本。" });
        }
        const parsed = parseCsv(body.csv);
        if (parsed.headers.length === 0) {
            return reply.code(400).send({ error: "CSV 没有可读的表头行。" });
        }
        return {
            headers: parsed.headers,
            rowCount: parsed.rows.length,
            preview: parsed.rows.slice(0, 5),
            guess: guessMapping(parsed.headers),
        };
    });

    app.post("/api/import/apply", async (request, reply) => {
        const body = (request.body ?? {}) as {
            csv?: unknown;
            mapping?: unknown;
            defaultStatus?: unknown;
            defaultAuthorId?: unknown;
            unmatchedAuthor?: unknown;
        };
        if (typeof body.csv !== "string" || body.csv.trim() === "") {
            return reply.code(400).send({ error: "没有收到 CSV 文本。" });
        }
        const mapping: ImportMapping = {};
        if (body.mapping !== null && typeof body.mapping === "object") {
            for (const [key, value] of Object.entries(body.mapping as Record<string, unknown>)) {
                mapping[key] = typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
            }
        }
        const defaultStatus =
            typeof body.defaultStatus === "string" && ["publish", "draft", "future"].includes(body.defaultStatus)
                ? body.defaultStatus
                : "draft";
        const defaultAuthorId =
            typeof body.defaultAuthorId === "number" && Number.isInteger(body.defaultAuthorId) && body.defaultAuthorId > 0
                ? body.defaultAuthorId
                : null;
        const unmatchedAuthor = body.unmatchedAuthor === "default" ? "default" : "error";

        const termOptions: Record<string, { id: number; name: string; slug: string }[]> = {};
        for (const term of listTerms()) {
            (termOptions[term.taxonomy] ??= []).push({ id: term.id, name: term.name, slug: term.slug });
        }

        const built = buildImportRows(parseCsv(body.csv), mapping, {
            authors: listAuthors(),
            termOptions,
            defaultStatus,
            defaultAuthorId,
            unmatchedAuthor,
        });
        if (built.fatal !== null) {
            return reply.code(400).send({ error: built.fatal });
        }

        const localIds = importPosts(built.rows);
        return { imported: localIds.length, failed: built.errors.length, errors: built.errors, localIds };
    });

    // Pull, push and the completion push all own the site link and the
    // progress slot; they must not interleave — two tabs defeat the
    // client-side busy flag, and a push racing a sync's row merge would
    // write snapshots against moving rows. One in-flight slot serializes
    // them; the loser gets a 409.
    type SiteOperation = "sync" | "push" | "completion";
    const OPERATION_LABEL: Record<SiteOperation, string> = {
        sync: "拉取",
        push: "推送",
        completion: "补完推送",
    };
    let siteOperation: SiteOperation | null = null;
    const slotBusy = (reply: { code: (code: number) => { send: (body: unknown) => unknown } }) => {
        const label = siteOperation === null ? "" : OPERATION_LABEL[siteOperation];
        return reply.code(409).send({ error: label === "" ? "操作进行中" : `已有${label}在进行中，等它结束再试。` });
    };

    app.post("/api/sync", async (request, reply) => {
        if (siteOperation !== null) {
            return slotBusy(reply);
        }
        siteOperation = "sync";
        try {
            return await runSync();
        } finally {
            setProgress(null);
            siteOperation = null;
        }
    });

    app.post("/api/push", async (request, reply) => {
        const body = (request.body ?? {}) as { localIds?: number[] };
        if (siteOperation !== null) {
            return slotBusy(reply);
        }
        siteOperation = "push";
        try {
            return await runPush(Array.isArray(body.localIds) ? body.localIds : undefined);
        } finally {
            setProgress(null);
            siteOperation = null;
        }
    });

    // --- FileServe completion flow (文件补完) -------------------------------

    app.post("/api/fileserve-sink/generate", async (request, reply) => {
        const body = (request.body ?? {}) as { localId?: unknown };
        const localId = Number(body.localId);
        if (!Number.isInteger(localId)) {
            return reply.code(400).send({ error: "缺少 localId。" });
        }
        const row = getPost(localId);
        if (!row) {
            return reply.code(404).send({ error: "本地行不存在。" });
        }
        const settings = getSettings();
        const workRoot = settings.workRoot.trim();
        if (workRoot === "") {
            return reply.code(400).send({ error: "先在设置里填好补完工作目录。" });
        }
        const template = parseTemplate(settings.fileserveTemplate);
        if (template.error !== null) {
            return reply.code(400).send({ error: template.error });
        }
        // The slug is decoration for the dir name; when the row predates the
        // slug column, one fetch backfills it. Failure falls back to the id.
        let slug = row.slug;
        if (slug === null && row.postId !== null) {
            try {
                const item = await getResource(
                    {
                        siteUrl: settings.siteUrl,
                        username: settings.username,
                        appPassword: settings.appPassword,
                        proxyUrl: settings.proxyUrl,
                    },
                    row.postId,
                );
                slug = parseSlugFromLink(item.link);
                if (slug !== null) {
                    updatePostRow(localId, { slug });
                }
            } catch {
                // dirNameFor falls back to the post id without a slug
            }
        }
        try {
            const result = generateSink(row, slug, {
                workRoot,
                dirNameMode: coerceDirNameMode(settings.dirNameMode),
                template: template.template,
            });
            return { ok: true, dirName: result.dirName, path: result.path };
        } catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.get("/api/fileserve-sink/scan", async (request) => {
        const settings = getSettings();
        const query = request.query as { localId?: string };
        const localId = query.localId !== undefined && query.localId !== "" ? Number(query.localId) : null;
        const sinks = listSinks(settings.workRoot).filter(
            (sink) => localId === null || !Number.isInteger(localId) || sink.carrier?.localId === localId,
        );
        return { workRoot: settings.workRoot, sinks };
    });

    app.post("/api/fileserve-sink/push", async (request, reply) => {
        const body = (request.body ?? {}) as { dirNames?: unknown };
        if (siteOperation !== null) {
            return slotBusy(reply);
        }
        siteOperation = "completion";
        try {
            const dirNames = Array.isArray(body.dirNames) ? body.dirNames.map(String) : undefined;
            return await runCompletionPush(dirNames);
        } finally {
            setProgress(null);
            siteOperation = null;
        }
    });

    app.post("/api/fileserve-sink/open", async (request, reply) => {
        const body = (request.body ?? {}) as { dirName?: unknown };
        const dirName = String(body.dirName ?? "");
        if (dirName === "" || dirName === "." || dirName === ".." || !/^[A-Za-z0-9._-]+$/.test(dirName)) {
            return reply.code(400).send({ error: "目录名无效。" });
        }
        const workRoot = getSettings().workRoot.trim();
        if (workRoot === "") {
            return reply.code(400).send({ error: "先在设置里填好补完工作目录。" });
        }
        const dir = path.join(workRoot, dirName);
        if (!existsSync(dir)) {
            return reply.code(404).send({ error: "目录不存在。" });
        }
        const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
        spawn(command, [dir], { detached: true, stdio: "ignore" }).unref();
        return { ok: true };
    });

    app.get("/api/progress", async () => getProgress());

    // The operational log: the client polls incrementally by id, so a full
    // reload hands it the newest window and a running client only the delta.
    app.get("/api/logs", async (request) => {
        const query = request.query as { after?: string; limit?: string };
        const after = Number(query.after ?? "0");
        const limit = Number(query.limit ?? "300");
        return {
            logs: listLogs(Number.isFinite(after) && after >= 0 ? after : 0, Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 1000) : 300),
        };
    });

    app.post("/api/logs/clear", async () => {
        return { ok: true, cleared: clearLogs() };
    });

    const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
    if (existsSync(distDir)) {
        await app.register(fastifyStatic, { root: distDir });
        app.setNotFoundHandler(async (request, reply) => {
            if (request.url.startsWith("/api/")) {
                return reply.code(404).send({ error: `not found: ${request.method} ${request.url}` });
            }
            return reply.type("text/html").sendFile("index.html");
        });
    }

    return app;
}

const PORT = Number(process.env.PUBLISHER_PORT ?? 5175);

// Only a directly-run process binds the port; a test import builds the app
// and talks to it with inject.
const isEntry = (() => {
    const entry = process.argv[1];
    if (!entry) {
        return false;
    }
    try {
        return pathToFileURL(entry).href === import.meta.url;
    } catch {
        return false;
    }
})();

if (isEntry) {
    let current: FastifyInstance | null = null;

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        // tsx watch restarts the child with SIGTERM; closing the listener here
        // frees the port before exit, or the next start dies on EADDRINUSE.
        process.on(signal, () => {
            // A null instance (mid-build, mid-retry) has nothing to close —
            // but registering the handler already suppressed the default
            // exit, so exit directly or Ctrl+C before bind hangs the process.
            if (current) {
                current.close().finally(() => process.exit(0));
            } else {
                process.exit(0);
            }
        });
    }

    // The retry exists for the hard-kill orphan: a publisher killed without
    // its signal handlers leaves the old server holding the port, and the
    // portguard evicts exactly that squatter (our own /api/state fingerprint)
    // before the second bind attempt. Anything else on the port aborts with
    // its PID instead of being touched.
    for (let attempt = 0; ; attempt += 1) {
        const app = await buildApp();
        current = app;
        try {
            await app.listen({ port: PORT, host: "127.0.0.1" });
        } catch (error) {
            await app.close().catch(() => {});
            current = null;
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "EADDRINUSE" || attempt > 0) {
                if (code === "EADDRINUSE") {
                    const squatter = listenerPid(PORT);
                    console.error(
                        `端口 ${PORT} 仍被占用（PID ${squatter?.pid ?? "?"}${squatter?.image ? `，${squatter.image}` : ""}）——结束它后再启动。`,
                    );
                } else {
                    console.error(error);
                }
                process.exit(1);
            }
            const squatter = listenerPid(PORT);
            if (!squatter || !(await isOurStateEndpoint(PORT))) {
                logEvent("error", "应用", `端口 ${PORT} 被其它进程占用，无法启动（PID ${squatter?.pid ?? "?"}）`);
                console.error(
                    `端口 ${PORT} 被其它进程占用（PID ${squatter?.pid ?? "?"}${squatter?.image ? `，${squatter.image}` : ""}）——不是本工具实例，请自行处理后再启动。`,
                );
                process.exit(1);
            }
            logEvent("warn", "应用", `端口 ${PORT} 上的残留实例被接管（PID ${squatter.pid}，强杀遗留的孤儿）`);
            console.log(`端口 ${PORT} 上是本工具的残留实例（PID ${squatter.pid}，强杀遗留的孤儿），接管中……`);
            killTree(squatter.pid);
            await new Promise((resolve) => setTimeout(resolve, 800));
            continue;
        }
        logEvent("info", "应用", `发帖器已启动：http://localhost:${PORT}`);
        console.log(`AIYA Publisher listening on http://localhost:${PORT}`);
        console.log(`db: ${dbPath}`);
        break;
    }
}

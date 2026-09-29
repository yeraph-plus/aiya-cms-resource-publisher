import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";
import {
    deletePost,
    getPost,
    getSettings,
    getTermRefs,
    insertPost,
    listAuthors,
    listPosts,
    listTerms,
    parseSnapshot,
    setSetting,
    setTermRefs,
    updatePostRow,
} from "./db.js";
import { runSync } from "./sync.js";
import { runPush } from "./push.js";
import { normalizeSiteUrl, ping, WpError } from "./wp.js";
import { normalizeConfig } from "../shared/fileserve.js";

const app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });

const PORT = Number(process.env.PUBLISHER_PORT ?? 5175);

function errorMessage(error: unknown): string {
    if (error instanceof WpError) {
        return `HTTP ${error.status}：${error.message}`;
    }
    return String(error);
}

function creds() {
    const settings = getSettings();
    return { siteUrl: settings.siteUrl, username: settings.username, appPassword: settings.appPassword };
}

function hasCreds(): boolean {
    const settings = getSettings();
    return Boolean(settings.siteUrl && settings.username && settings.appPassword);
}

app.get("/api/state", async () => {
    const settings = getSettings();
    const grouped: Record<string, { id: number; name: string; slug: string }[]> = {};
    for (const term of listTerms()) {
        (grouped[term.taxonomy] ??= []).push({ id: term.id, name: term.name, slug: term.slug });
    }
    // Group terms per taxonomy in the fixed registry order (category first).
    const order = ["resource_category", "resource_original", "resource_character", "resource_author", "resource_content", "resource_other"];
    const terms: Record<string, { id: number; name: string; slug: string }[]> = {};
    for (const slug of order) {
        if (grouped[slug]) {
            terms[slug] = grouped[slug] as { id: number; name: string; slug: string }[];
        }
    }

    return {
        settings: {
            siteUrl: settings.siteUrl,
            username: settings.username,
            hasPassword: settings.appPassword !== "",
            defaultAuthorId: settings.defaultAuthorId,
            lastSyncCursor: settings.lastSyncCursor,
        },
        authors: listAuthors(),
        terms,
        posts: listPosts().map((row) => ({
            ...row,
            terms: getTermRefs(row.localId),
            fileserveParsed: row.fileserve ? (JSON.parse(row.fileserve) as unknown) : null,
        })),
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
    if (body.defaultAuthorId !== undefined) {
        setSetting("defaultAuthorId", body.defaultAuthorId === null ? null : String(body.defaultAuthorId));
    }
    return reply.code(200).send({ ok: true });
});

app.post("/api/connect", async () => {
    if (!hasCreds()) {
        return { ok: false, error: "先填好站点地址、用户名和应用密码。" };
    }
    try {
        const probe = await ping(creds());
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

    const next = {
        status: String(body.status ?? row.status),
        title: String(body.title ?? row.title),
        content: String(body.content ?? row.content),
        authorId: body.authorId === null || body.authorId === undefined ? null : Number(body.authorId),
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
        row: saved
            ? { ...saved, terms: getTermRefs(localId), fileserveParsed: saved.fileserve ? JSON.parse(saved.fileserve) : null }
            : null,
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

app.post("/api/sync", async () => {
    const outcome = await runSync();
    return outcome;
});

app.post("/api/push", async (request) => {
    const body = (request.body ?? {}) as { localIds?: number[] };
    const outcome = await runPush(Array.isArray(body.localIds) ? body.localIds : undefined);
    return outcome;
});

const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
if (existsSync(distDir)) {
    await app.register(fastifyStatic, { root: distDir });
    app.setNotFoundHandler(async (request, reply) => {
        if (request.url.startsWith("/api/")) {
            return reply.code(404).send({ error: "not found" });
        }
        return reply.type("text/html").sendFile("index.html");
    });
}

app.listen({ port: PORT, host: "127.0.0.1" }).then(() => {
    console.log(`AIYA Publisher listening on http://localhost:${PORT}`);
});

export { app };

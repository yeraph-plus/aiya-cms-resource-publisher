import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
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
import { fileServeState } from "./fileserveState.js";
import { appliedSince, applyResult, buildQueue } from "./netdisklane.js";
import { ensureStagingDir, findStagingDir, openStagingDir } from "./dirs.js";
import { isOurStateEndpoint, killTree, listenerPid } from "./portguard.js";
import { getProgress, setProgress } from "./progress.js";
import { normalizeSiteUrl, ping, uploadImage, WpError } from "./wp.js";
import { parseCsv } from "../shared/csv.js";
import { buildImportRows, guessMapping, TAXONOMY_ORDER, type ImportMapping } from "../shared/import.js";
import { mergeFileserveDraft, mergeRemoteFileserve, normalizeConfig } from "../shared/fileserve.js";

export async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });

    // --- 只接受本机请求 -------------------------------------------------------
    // The tool listens on a fixed localhost port and its whole job is writing
    // to a live site, so any page the user happens to have open can reach it.
    // Fastify parses text/plain out of the box, which makes a cross-site
    // `fetch(..., { mode: "no-cors" })` a *simple* request: no preflight, no
    // CORS check, and the write already happened by the time the browser
    // refuses to hand the response back. Origin and Host are therefore checked
    // here, before any route runs. The netdisk endpoints are cross-origin by
    // design and stay pinned to their one allowed origin; the Host check is
    // what also closes DNS rebinding, where Origin looks same-site but the
    // name points at this machine.
    const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
    const NETDISK_ORIGIN = "https://pan.baidu.com";
    /** A userscript manager's own origin (Tampermonkey's GM_xmlhttpRequest). */
    const isExtensionOrigin = (origin: string): boolean =>
        /^(chrome|moz|safari-web|ms-browser)-extension:\/\//.test(origin);
    const hostnameOf = (value: string): string | null => {
        try {
            return new URL(value.includes("://") ? value : `http://${value}`).hostname;
        } catch {
            return null;
        }
    };
    app.addHook("onRequest", async (request, reply) => {
        const host = hostnameOf(String(request.headers.host ?? ""));
        if (host === null || !LOCAL_HOSTS.has(host)) {
            return reply.code(403).send({ error: "只接受来自本机的请求。" });
        }
        const origin = request.headers.origin;
        if (typeof origin !== "string" || origin === "") {
            // No Origin: a same-origin fetch, curl, or the Electron shell.
            return;
        }
        const originHost = hostnameOf(origin);
        if (originHost !== null && LOCAL_HOSTS.has(originHost)) {
            return;
        }
        // The netdisk script is the one legitimate cross-origin caller. Its
        // requests either carry the page origin (plain fetch) or come from the
        // userscript manager's own extension context — GM_xmlhttpRequest sends
        // the extension origin, or no usable one at all, and it skips CORS
        // entirely. A web page can only ever present its own http(s) origin, so
        // allowing the script's shapes here still keeps other sites out.
        if (request.url.startsWith("/api/netdisk/") && (origin === NETDISK_ORIGIN || isExtensionOrigin(origin))) {
            return;
        }
        return reply.code(403).send({ error: "跨站请求被拒绝。" });
    });

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
        fileServe: fileServeState(saved),
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
                    dirNameSuffix: settings.dirNameSuffix,
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
        if (body.dirNameSuffix !== undefined) {
            const suffix = String(body.dirNameSuffix);
            if (!["slug", "title", "none"].includes(suffix)) {
                return reply.code(400).send({ error: "目录命名后缀无效。" });
            }
            setSetting("dirNameSuffix", suffix);
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
    // The stored row travels back with the id: the client appends it to the
    // table instead of refetching every post just to see one new row.
    const saved = getPost(localId);
    return { localId, row: saved ? rowWithTerms(saved) : null };
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

    // Optimistic concurrency for the file list. The netdisk lane fills links
    // behind the client's back, and a detail panel that was opened before that
    // fill holds a draft whose link is still empty — saving *any* field of the
    // row would put that draft back and destroy the link. A patch that says
    // which version it was based on is therefore merged against the stored one
    // per group, so the fill survives while the user's own edits still land.
    // A patch without a base (an older client, a plain cell edit) keeps the
    // previous write-through behaviour.
    const { fileserveBase } = body;
    const hasFileserveBase = fileserveBase !== undefined;
    let fileserveMoved = false;
    let fileserve: string | null;
    if (!providesFileserve) {
        fileserve = row.fileserve;
    } else if (hasFileserveBase) {
        const base = fileserveBase === null ? null : String(fileserveBase);
        const merged = mergeFileserveDraft(parseFileserve(base), config, parseFileserve(row.fileserve));
        fileserveMoved = merged.moved;
        fileserve = Object.keys(merged.config).length > 0 ? JSON.stringify(merged.config) : "{}";
    } else {
        fileserve = Object.keys(config).length > 0 ? JSON.stringify(config) : "{}";
    }

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
        // True when the patch's file list lost to a newer one (a netdisk fill);
        // the returned row carries what is actually stored.
        fileserveMoved,
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
        // Like every other site-confirmation write-back, the revert keeps the
        // row's local draft groups (push off) — the snapshot stores the site
        // shape only.
        fileserve: mergeRemoteFileserve(snapshot.fileserve ?? null, row.fileserve),
        dirty: false,
        conflict: false,
        lastError: null,
    });
    setTermRefs(localId, snapshot.terms);
    const reverted = getPost(localId);
    return { ok: true, row: reverted ? rowWithTerms(reverted) : null };
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

    // Pull and push own the site link and the progress slot; they must not
    // interleave — two tabs defeat the client-side busy flag, and a push
    // racing a sync's row merge would write snapshots against moving rows.
    // One in-flight slot serializes them; the loser gets a 409.
    type SiteOperation = "sync" | "push";
    const OPERATION_LABEL: Record<SiteOperation, string> = {
        sync: "拉取",
        push: "推送",
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

    app.get("/api/progress", async () => getProgress());

    // --- 正文插图（图片上传）-------------------------------------------------
    // The picked file arrives as base64 JSON rather than multipart: the
    // browser has to read it into memory either way, and a 10MB image
    // encodes to ~13.4MB — inside the 16MB body limit, so the tool keeps
    // its single JSON request shape and the server does the multipart leg
    // to the site.
    const UPLOAD_MAX_MB = 10;
    const UPLOAD_MAX_BYTES = UPLOAD_MAX_MB * 1024 * 1024;

    app.post("/api/uploads/image", async (request, reply) => {
        const body = (request.body ?? {}) as { filename?: unknown; mime?: unknown; dataBase64?: unknown };
        const filename = typeof body.filename === "string" ? body.filename.trim() : "";
        const encoded = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
        if (filename === "" || encoded === "") {
            return reply.code(400).send({ error: "没有收到图片数据。" });
        }
        // Reject before decoding: Buffer.from() would happily eat garbage.
        if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
            return reply.code(400).send({ error: "图片数据不是合法的 base64。" });
        }
        const bytes = Buffer.from(encoded, "base64");
        if (bytes.length === 0) {
            return reply.code(400).send({ error: "图片数据为空。" });
        }
        if (bytes.length > UPLOAD_MAX_BYTES) {
            return reply.code(413).send({ error: `图片超过 ${UPLOAD_MAX_MB}MB 上限（站点图床的限制）。` });
        }
        const settings = getSettings();
        if (!settings.siteUrl || !settings.username || !settings.appPassword) {
            return reply.code(400).send({ error: "先填好站点地址、用户名和应用密码。" });
        }
        try {
            const uploaded = await uploadImage(
                {
                    siteUrl: settings.siteUrl,
                    username: settings.username,
                    appPassword: settings.appPassword,
                    proxyUrl: settings.proxyUrl,
                },
                filename,
                typeof body.mime === "string" ? body.mime : "",
                bytes,
            );
            logEvent("info", "上传", `${filename} → ${uploaded.path}`);
            return uploaded;
        } catch (error) {
            logEvent("error", "上传", `${filename}：${errorMessage(error)}`);
            return reply.code(400).send({ error: errorMessage(error) });
        }
    });

    // --- Local staging directories (本地目录，纯本地辅助) ---------------------
    // A convenience for staging files locally before the client upload; the
    // netdisk lane neither reads nor requires it — the script names and
    // creates the netdisk folder itself from the queue item. A blocked ensure
    // is an expected condition (unpublished row, unconfigured root), so
    // ensure answers 200 with status "blocked"; open answers 400 so a clicked
    // button shows the reason.

    app.post("/api/fileserve-dir/ensure", async (request, reply) => {
        const body = (request.body ?? {}) as { localId?: unknown };
        const localId = Number(body.localId);
        if (!Number.isInteger(localId) || localId <= 0) {
            return reply.code(400).send({ error: "缺少 localId。" });
        }
        return ensureStagingDir(localId);
    });

    app.post("/api/fileserve-dir/open", async (request, reply) => {
        const body = (request.body ?? {}) as { localId?: unknown };
        const localId = Number(body.localId);
        if (!Number.isInteger(localId) || localId <= 0) {
            return reply.code(400).send({ error: "缺少 localId。" });
        }
        const result = openStagingDir(localId);
        if (result.status === "blocked") {
            return reply.code(400).send({ error: result.reason });
        }
        return result;
    });

    app.get("/api/fileserve-dir/:localId", async (request, reply) => {
        const localId = Number((request.params as { localId: string }).localId);
        const row = getPost(localId);
        if (!row) {
            return reply.code(404).send({ error: "本地行不存在。" });
        }
        if (row.postId === null) {
            return { dir: null, name: null };
        }
        const found = findStagingDir(row.postId);
        return { dir: found?.dir ?? null, name: found?.name ?? null };
    });

    // --- Netdisk share lane (网盘分享回填) -----------------------------------
    // The userscript on pan.baidu.com polls the queue and posts share links
    // back. CORS is pinned to the netdisk origin: the page's own fetch needs
    // it, and pinning keeps every other site blind to the local tool. The
    // origin itself is declared with the local-only guard at the top, which is
    // what actually enforces it.
    const netdiskCors = (reply: FastifyReply): void => {
        reply.header("Access-Control-Allow-Origin", NETDISK_ORIGIN).header("Vary", "Origin");
    };

    // How an open client hears that the lane filled a link behind its back.
    // Same-origin only (no CORS header here): the app polls it, the userscript
    // never does. The whole row travels with it — the client splices single
    // rows, so no second round trip is needed to see the filled link.
    app.get("/api/netdisk/applied", async (request) => {
        const query = request.query as { after?: string };
        const after = Number(query.after ?? "0");
        const { cursor, localIds } = appliedSince(Number.isFinite(after) && after >= 0 ? after : 0);
        const rows: ReturnType<typeof rowWithTerms>[] = [];
        for (const localId of localIds) {
            const row = getPost(localId);
            if (row) {
                rows.push(rowWithTerms(row));
            }
        }
        return { cursor, rows };
    });

    for (const path of ["/api/netdisk/queue", "/api/netdisk/result"]) {
        app.options(path, async (request, reply) => {
            netdiskCors(reply);
            return reply
                .code(204)
                .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                .header("Access-Control-Allow-Headers", "Content-Type")
                .header("Access-Control-Max-Age", "600")
                .send();
        });
    }

    app.get("/api/netdisk/queue", async (request, reply) => {
        netdiskCors(reply);
        const query = request.query as { netdisk?: string };
        const netdisk = typeof query.netdisk === "string" && query.netdisk.trim() !== "" ? query.netdisk.trim() : "baidu";
        return { netdisk, queue: buildQueue(netdisk) };
    });

    app.post("/api/netdisk/result", async (request, reply) => {
        netdiskCors(reply);
        const body = (request.body ?? {}) as Record<string, unknown>;
        const localId = Number(body.localId);
        const groupId = String(body.groupId ?? "");
        const url = String(body.url ?? "");
        const code = String(body.code ?? "");
        const netdisk = typeof body.netdisk === "string" && body.netdisk.trim() !== "" ? body.netdisk.trim() : "baidu";
        if (!Number.isInteger(localId) || localId <= 0 || groupId === "") {
            return reply.code(400).send({ error: "缺少 localId 或 groupId。" });
        }
        const outcome = applyResult(netdisk, localId, groupId, url, code);
        if (!outcome.ok) {
            return reply.code(400).send({ error: outcome.error });
        }
        return { ok: true, row: rowWithTerms(outcome.row) };
    });

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

export const PUBLISHER_PORT = Number(process.env.PUBLISHER_PORT ?? 5175);

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

/**
 * Binds the fixed local port, taking over a stale instance of the same
 * executable that a hard kill left holding it.
 *
 * Shared by the CLI entry (npm start / tsx watch) and the Electron shell, so
 * both flavours answer on the same 5175 the Tampermonkey netdisk script
 * points at — the packaged app used to pick a random port, which the script
 * could never find.
 *
 * A squatter from the other flavour (dev holding the port while the packaged
 * app starts, or the reverse) is reported instead of killed: dev and the
 * packaged app share one port on purpose, so only one of them may run.
 */
export async function listenWithPortguard(port: number = PUBLISHER_PORT): Promise<FastifyInstance> {
    // The retry exists for the hard-kill orphan: a publisher killed without
    // its signal handlers leaves the old server holding the port, and the
    // portguard evicts exactly that squatter (our own /api/state fingerprint)
    // before the second bind attempt. Anything else on the port aborts with
    // its PID instead of being touched.
    for (let attempt = 0; ; attempt += 1) {
        const app = await buildApp();
        try {
            await app.listen({ port, host: "127.0.0.1" });
        } catch (error) {
            await app.close().catch(() => {});
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "EADDRINUSE" || attempt > 0) {
                if (code === "EADDRINUSE") {
                    const squatter = listenerPid(port);
                    console.error(
                        `端口 ${port} 仍被占用（PID ${squatter?.pid ?? "?"}${squatter?.image ? `，${squatter.image}` : ""}）——结束它后再启动。`,
                    );
                } else {
                    console.error(error);
                }
                throw error;
            }
            const squatter = listenerPid(port);
            if (!squatter || !(await isOurStateEndpoint(port))) {
                logEvent("error", "应用", `端口 ${port} 被其它进程占用，无法启动（PID ${squatter?.pid ?? "?"}）`);
                console.error(
                    `端口 ${port} 被其它进程占用（PID ${squatter?.pid ?? "?"}${squatter?.image ? `，${squatter.image}` : ""}）——不是本工具实例，请自行处理后再启动。`,
                );
                throw error;
            }
            const selfImage = path.basename(process.execPath);
            if (squatter.image !== null && squatter.image.toLowerCase() !== selfImage.toLowerCase()) {
                logEvent(
                    "error",
                    "应用",
                    `端口 ${port} 上是本工具的另一个形态（PID ${squatter.pid}，${squatter.image}），当前进程是 ${selfImage}`,
                );
                console.error(
                    `端口 ${port} 上是本工具的另一个形态（PID ${squatter.pid}，${squatter.image}）——dev 与打包版共用该端口，先关掉它再启动。`,
                );
                throw error;
            }
            logEvent("warn", "应用", `端口 ${port} 上的残留实例被接管（PID ${squatter.pid}，强杀遗留的孤儿）`);
            console.log(`端口 ${port} 上是本工具的残留实例（PID ${squatter.pid}，强杀遗留的孤儿），接管中……`);
            killTree(squatter.pid);
            await new Promise((resolve) => setTimeout(resolve, 800));
            continue;
        }
        logEvent("info", "应用", `发帖器已启动：http://localhost:${port}`);
        console.log(`AIYA Publisher listening on http://localhost:${port}`);
        console.log(`db: ${dbPath}`);
        return app;
    }
}

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

    try {
        current = await listenWithPortguard();
    } catch {
        // listenWithPortguard already reported the squatter (PID and image).
        process.exit(1);
    }
}

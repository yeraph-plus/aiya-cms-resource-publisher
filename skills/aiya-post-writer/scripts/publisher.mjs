#!/usr/bin/env node
/**
 * The five named calls a drafting agent is allowed to make. Each one maps to
 * exactly one local endpoint, and the endpoint base is resolved here rather
 * than written into a prompt: the publisher listens on a port that the user
 * may move (PUBLISHER_PORT), and a skill that pastes a URL into a body is a
 * skill that breaks the day that happens.
 *
 * Deliberately not a general HTTP client. There is no `--method`, no `--path`,
 * no "call this endpoint" escape hatch: reading a row, pushing a row,
 * deleting a row and touching the settings all sit behind the same local
 * server, and the point of naming five verbs is that the other doors are not
 * reachable from a prompt.
 *
 *   context  → GET  /api/ingest/context   vocabulary, authors, defaults, caps
 *   lookup   → GET  /api/state            duplicate check against local rows
 *   stage    → POST /api/images           copy an image into <data>/images
 *   preview  → POST /api/ingest/preview   validate without writing
 *   ingest   → POST /api/ingest           write dirty rows
 *
 * Node 24, no dependencies — the agent runs this from the repo, not from an
 * installed package.
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

/** Tried in order when PUBLISHER_BASE is unset. The first answering the
 * ingest-context fingerprint wins; anything else is not this tool. */
const CANDIDATE_PORTS = [5175];

/** Mirrors server/images.ts: the site's pic bed refuses more than this. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXT = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
};

const USAGE = `用法：node skills/aiya-post-writer/scripts/publisher.mjs <命令> [参数]

  context [--lines] [--taxonomy <slug>] [--limit <n>]
      做草稿要用的参照：六词法（带 id / 路径 / 使用次数）、作者、默认状态、行数上限。
      --lines 打成「id<TAB>路径<TAB>次数」的文本，比整份 JSON 省上下文。

  lookup <文本> [--limit <n>]
      本地查重：标题包含该文本的行（localId / postId / 状态 / 是否待推送）。

  stage <本地文件> [--name <显示名>]
  stage --url <图片地址> [--name <显示名>]
      把图片复制进 <数据目录>/images，回 { path, src, name }；正文里引用 src。
      同一张图重复暂存不会多存一份。

  preview <payload.json | -> [--pretty]
      校验并归一化，不写库。payload 可以是 { rows: [...] } 或直接数组。

  ingest <payload.json | -> [--pretty] [--source <署名>]
      入队为待推送的本地行。只入队，不推送。

退出码：0 成功；1 调用失败；2 请求成功但有行被拒（看 errors）。
`;

function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
}

function parseArgs(argv) {
    const positional = [];
    const flags = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token.startsWith("--")) {
            const key = token.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith("--")) {
                flags[key] = true;
            } else {
                flags[key] = next;
                i += 1;
            }
            continue;
        }
        positional.push(token);
    }
    return { positional, flags };
}

function normalizeBase(value) {
    const trimmed = value.trim().replace(/\/+$/, "");
    return /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** The context body doubles as the fingerprint, so the probe costs nothing. */
async function fetchContext(base) {
    const response = await fetch(`${base}/api/ingest/context`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) {
        return null;
    }
    const body = await response.json();
    if (body === null || typeof body !== "object" || !("ingestMaxRows" in body) || !("terms" in body)) {
        return null;
    }
    return body;
}

/**
 * Resolves where the publisher is listening. An explicit base wins; otherwise
 * the default port is fingerprinted so a stale unrelated server on 5175 is not
 * mistaken for the publisher.
 */
async function resolveBase() {
    const explicit = process.env.PUBLISHER_BASE;
    if (typeof explicit === "string" && explicit.trim() !== "") {
        const base = normalizeBase(explicit);
        const context = await fetchContext(base).catch(() => null);
        if (context === null) {
            fail(`连不上发帖器：PUBLISHER_BASE=${base} 没有回应，或那不是发帖器。先启动桌面版，或 npm run dev。`);
        }
        return { base, context };
    }
    for (const port of CANDIDATE_PORTS) {
        const base = `http://127.0.0.1:${port}`;
        const context = await fetchContext(base).catch(() => null);
        if (context !== null) {
            return { base, context };
        }
    }
    fail(
        "连不上发帖器：先启动桌面版，或在仓库里跑 npm run dev。\n" +
            `（探过的地址：${CANDIDATE_PORTS.map((port) => `127.0.0.1:${port}`).join("、")}；` +
            "端口不一样时用 PUBLISHER_BASE 指定。）",
    );
}

async function callApi(base, method, path, body) {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    let parsed;
    try {
        parsed = text === "" ? null : JSON.parse(text);
    } catch {
        parsed = text;
    }
    if (!response.ok) {
        const detail = parsed && typeof parsed === "object" && "error" in parsed ? parsed.error : text;
        fail(`请求失败（HTTP ${response.status}）：${String(detail).slice(0, 500)}`);
    }
    return parsed;
}

function printJson(value, pretty) {
    process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

async function readPayload(pathOrDash) {
    if (pathOrDash === undefined) {
        fail("缺少 payload：给一个 JSON 文件路径，或用 - 从 stdin 读。");
    }
    const raw =
        pathOrDash === "-"
            ? readFileSync(0, "utf8")
            : await readFile(pathOrDash, "utf8").catch(() => fail(`读不到 payload 文件：${pathOrDash}`));
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        fail(`payload 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
    if (Array.isArray(parsed)) {
        return { rows: parsed };
    }
    if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.rows)) {
        fail("payload 必须是 { rows: [...] } 或直接一个行数组。");
    }
    return parsed;
}

/** Reads an image over HTTP so the agent never has to hand-roll a download. */
async function downloadImage(url) {
    let response;
    try {
        response = await fetch(url, {
            redirect: "follow",
            headers: {
                // Official sites and image hosts answer a bare undici UA with 403 often enough to matter.
                "user-agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
                accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
            },
            signal: AbortSignal.timeout(30000),
        });
    } catch (error) {
        fail(`下载失败：${url}（${error instanceof Error ? error.message : String(error)}）`);
    }
    if (!response.ok) {
        fail(`下载失败：${url}（HTTP ${response.status}）`);
    }
    const mime = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!mime.startsWith("image/")) {
        fail(`不是图片：${url} 回的是 ${mime || "（无 content-type）"}。`);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_IMAGE_BYTES) {
        fail(`图片太大：${(declared / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB。`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) {
        fail(`图片太大：${(bytes.length / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB。`);
    }
    const fromUrl = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return { bytes, mime, filename: MIME_BY_EXT[extname(fromUrl).slice(1).toLowerCase()] ? fromUrl : `image-${Date.now()}.${mime.split("/")[1] ?? "bin"}` };
}

async function commandContext(base, context, flags) {
    if (flags.lines !== true) {
        if (typeof flags.taxonomy === "string") {
            printJson(context.terms[flags.taxonomy] ?? [], flags.pretty === true);
            return 0;
        }
        printJson(context, flags.pretty === true);
        return 0;
    }
    const limit = Number(flags.limit ?? 300);
    const order = ["resource_category", "resource_original", "resource_character", "resource_author", "resource_content", "resource_other"];
    const lines = [
        `# 站点 ${context.siteUrl || "（未配置）"}｜默认作者 ${context.defaultAuthorId ?? "未设置"}｜默认状态 ${context.defaultStatus}｜单次上限 ${context.ingestMaxRows} 行`,
        "# 分类是层级词法，用 id 引用（按名称匹配会撞同名子分类）；其余词法 id 或名称都可以，优先 id",
    ];
    for (const taxonomy of order) {
        const list = context.terms[taxonomy] ?? [];
        if (list.length === 0) {
            continue;
        }
        lines.push(`## ${taxonomy}（${list.length} 个，按使用次数）`);
        for (const term of list.slice(0, limit)) {
            lines.push(`${term.id}\t${term.path ?? term.name}\t${term.count}`);
        }
    }
    lines.push(`## authors（作者账号，不是 resource_author 术语）`);
    for (const author of context.authors) {
        lines.push(`${author.id}\t${author.name}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
}

async function commandLookup(base, flags, positional) {
    const query = positional.join(" ").trim();
    if (query === "") {
        fail("lookup 需要一个用于比对的标题片段。");
    }
    const state = await callApi(base, "GET", "/api/state");
    const needle = query.toLowerCase();
    const limit = Number(flags.limit ?? 20);
    const hits = (state.posts ?? [])
        .filter((row) => String(row.title ?? "").toLowerCase().includes(needle))
        .slice(0, limit)
        .map((row) => ({
            localId: row.localId,
            postId: row.postId,
            status: row.status,
            title: row.title,
            dirty: row.dirty,
            missing: row.missing,
            lastError: row.lastError,
        }));
    printJson({ query, count: hits.length, rows: hits }, flags.pretty === true);
    return 0;
}

async function commandStage(base, flags, positional) {
    let filename;
    let mime;
    let bytes;
    if (typeof flags.url === "string") {
        const downloaded = await downloadImage(flags.url);
        ({ filename, mime, bytes } = downloaded);
    } else {
        const path = positional[0];
        if (path === undefined) {
            fail("stage 需要本地文件路径，或用 --url 给图片地址。");
        }
        if (!existsSync(path)) {
            fail(`文件不存在：${path}`);
        }
        filename = basename(path);
        mime = MIME_BY_EXT[extname(path).slice(1).toLowerCase()] ?? "";
        if (mime === "") {
            fail(`不支持的图片格式：${extname(path) || "（无扩展名）"}（只接受 PNG / JPEG / GIF / WebP / AVIF / BMP）。`);
        }
        bytes = await readFile(path);
    }
    if (typeof flags.name === "string" && flags.name.trim() !== "") {
        filename = flags.name.trim();
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
        fail(`图片太大：${(bytes.length / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB。`);
    }
    const staged = await callApi(base, "POST", "/api/images", {
        filename,
        mime,
        dataBase64: Buffer.from(bytes).toString("base64"),
    });
    printJson(staged, flags.pretty === true);
    return 0;
}

/** preview and ingest differ only in the route and the signature. */
async function commandIngestable(base, flags, positional, write) {
    const payload = await readPayload(positional[0]);
    const body = !write ? payload : { ...payload, source: typeof flags.source === "string" ? flags.source.trim() : "" };
    const result = await callApi(base, "POST", write ? "/api/ingest" : "/api/ingest/preview", body);
    printJson(result, flags.pretty === true);
    // Rows rejected by the builder: the call worked, the draft did not.
    return Array.isArray(result.errors) && result.errors.length > 0 ? 2 : 0;
}

async function main(argv) {
    const { positional, flags } = parseArgs(argv);
    const command = positional.shift();
    if (command === undefined || flags.help === true || command === "help") {
        process.stdout.write(USAGE);
        return command === undefined ? 1 : 0;
    }
    const known = ["context", "lookup", "stage", "preview", "ingest"];
    if (!known.includes(command)) {
        fail(`未知命令：${command}\n\n${USAGE}`);
    }

    const { base, context } = await resolveBase();
    switch (command) {
        case "context":
            return commandContext(base, context, flags);
        case "lookup":
            return commandLookup(base, flags, positional);
        case "stage":
            return commandStage(base, flags, positional);
        case "preview":
            return commandIngestable(base, flags, positional, false);
        case "ingest":
            return commandIngestable(base, flags, positional, true);
        default:
            return 1;
    }
}

main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => fail(error instanceof Error ? error.message : String(error)));

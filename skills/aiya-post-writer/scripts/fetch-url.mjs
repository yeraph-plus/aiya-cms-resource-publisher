#!/usr/bin/env node
/**
 * One URL in, one file on disk out — direct first, local HTTP proxy second.
 *
 * Why this exists: itch.io, Steam 商店页、archive.org 和一部分日本厂商官网在
 * 直连下会整段超时（DNS 通、TCP 连不上，约 21 秒后 choke）。这类失败在核实
 * 环节要重演十几次，靠每条命令手写 `curl -x … -A … --max-time …` 迟早抄错一个
 * 参数，而抄错的后果是「判定 T1 不可达」这种整篇降级的误判。
 *
 * Why not a seventh publisher command: that table is the 写库 permission
 * surface — reading rows, pushing, deleting and settings all sit behind the
 * local server, which is why publisher.mjs refuses to be a general HTTP
 * client. Fetching a public page touches none of it, so it lives here as a
 * tool instead of widening that surface.
 *
 * Zero dependencies on purpose (same rule as publisher.mjs): it shells out to
 * the curl that ships with Windows 10+ / macOS / every Linux, which already
 * implements HTTP CONNECT and redirect handling correctly.
 *
 *   node scripts/fetch-url.mjs <url> [--out <path>] [--json]
 *
 * Exit 0 = 文件已落盘；1 = 直连与代理都没拿到。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

/** 本机常驻代理。换端口用 AIYA_PROXY 覆盖，别改这一行。 */
const PROXY = process.env.AIYA_PROXY ?? "http://127.0.0.1:10808";

/** 官方站与图床对裸 UA 回 403 是常态，这里统一用浏览器串。 */
const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

const MAX_TIME = 30;

/** 连接阶段单独限时：被挡的域是 TCP 层不响应，系统默认重试要 21 秒才报错，
 * 6 秒足够区分「连不上」和「慢但通」，省下的时间就是换走代理的时间。 */
const CONNECT_TIME = 6;

function fail(message) {
    console.error(message);
    process.exit(1);
}

const argv = process.argv.slice(2);
const url = argv.find((item) => !item.startsWith("--"));
const wantsJson = argv.includes("--json");
const outIndex = argv.indexOf("--out");
const outFlag = outIndex >= 0 ? argv[outIndex + 1] : undefined;

if (!url) {
    fail("用法：node scripts/fetch-url.mjs <url> [--out <path>] [--json]");
}
if (outIndex >= 0 && !outFlag) {
    fail("--out 后面要跟一个文件路径。");
}

let parsed;
try {
    parsed = new URL(url);
} catch {
    fail(`不是合法 URL：${url}`);
}
if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(`只取 http/https，收到 ${parsed.protocol}`);
}

/** 默认落到临时目录，用 URL 末段命名；没有末段就用主机名。 */
function defaultOut() {
    const tail = decodeURIComponent(basename(parsed.pathname)) || `${parsed.hostname}.html`;
    const safe = tail.replace(/[\\/:*?"<>|]/g, "_");
    return join(tmpdir(), extname(safe) ? safe : `${safe}.html`);
}

const out = outFlag ? resolve(outFlag) : defaultOut();
mkdirSync(dirname(out), { recursive: true });

/** 跑一次 curl。viaProxy 为真时加 -x，其余参数两种路线一致。 */
function attempt(viaProxy) {
    const args = ["-sS", "-L", "--max-time", String(MAX_TIME), "--connect-timeout", String(CONNECT_TIME), "-A", UA, "-o", out, "-w", "%{http_code}"];
    if (viaProxy) {
        args.push("-x", PROXY);
    }
    args.push(url);

    const result = spawnSync("curl", args, { encoding: "utf8" });
    if (result.error) {
        if (result.error.code === "ENOENT") {
            fail("本机没有 curl。Windows 10 1803 之后自带，Git Bash 也自带，先确认 PATH。");
        }
        return { ok: false, reason: String(result.error) };
    }

    const status = Number((result.stdout ?? "").trim().slice(-3));
    if (result.status !== 0) {
        // curl 的 28 是超时，7 是连不上——这两条正是「直连被挡」的主要形状。
        const detail = (result.stderr ?? "").trim().split("\n")[0] ?? "";
        return { ok: false, reason: detail || `curl 退出 ${result.status}` };
    }
    if (!(status >= 200 && status < 300)) {
        return { ok: false, reason: `HTTP ${status}` };
    }
    return { ok: true, status };
}

function discard() {
    if (existsSync(out)) {
        rmSync(out, { force: true });
    }
}

const direct = attempt(false);
let via = "direct";
let reach = direct;

if (!direct.ok) {
    discard();
    reach = attempt(true);
    via = "proxy";
}

if (!reach.ok) {
    discard();
    const message = `取不到：${url}\n  直连：${direct.reason}\n  代理（${PROXY}）：${reach.reason}`;
    if (wantsJson) {
        console.log(JSON.stringify({ ok: false, url, direct: direct.reason, proxy: reach.reason, out: null }, null, 2));
    }
    fail(message);
}

const bytes = statSync(out).size;
if (wantsJson) {
    console.log(JSON.stringify({ ok: true, url, via, status: reach.status, out, bytes }, null, 2));
} else {
    console.log(`${out}\n${bytes} 字节｜HTTP ${reach.status}｜${via === "proxy" ? `经代理 ${PROXY}` : "直连"}`);
}

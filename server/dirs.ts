/**
 * Upload staging directories: one folder per post under the configured root
 * (自动创建文件夹位置), named `{帖子ID}-{sanitized title}` with the id
 * zero-padded to five digits. Nothing is recorded — the leading padded id is
 * the only load-bearing part of a folder name, so the filesystem itself is
 * the source of truth: every ensure/open scans the root, claims a folder
 * already carrying the id (manual renames and title edits never break the
 * link) and otherwise creates one.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { getPost, getSetting, logEvent } from "./db.js";
import { stagingDirName, stagingId } from "../shared/staging-name.js";

export interface EnsureResult {
    status: "claimed" | "created" | "blocked";
    dir: string | null;
    name: string | null;
    reason?: string;
}

function blocked(reason: string): EnsureResult {
    return { status: "blocked", dir: null, name: null, reason };
}

/** The existing folder carrying the post's padded id, or null. The id
 * segment must equal `{帖子ID}` exactly (5-digit zero-padded) or open with
 * `{帖子ID}-` — the dash delimiter keeps 00502 from claiming 005025's
 * folder. Sorted so a copied pair resolves deterministically. */
export function findStagingDir(postId: number): { dir: string; name: string } | null {
    const workRoot = (getSetting("workRoot") ?? "").trim();
    if (workRoot === "" || !existsSync(workRoot)) {
        return null;
    }
    const id = stagingId(postId);
    const prefix = `${id}-`;
    const match = readdirSync(workRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && (entry.name === id || entry.name.startsWith(prefix)))
        .map((entry) => entry.name)
        .sort()[0];
    return match ? { dir: join(workRoot, match), name: match } : null;
}

/** Logged once per session: an unconfigured root blocks every ensure, and a
 * per-add warn would spam the console on a row edited repeatedly. */
let warnedRootMissing = false;

/**
 * Idempotent and stateless: a folder already carrying the post's id is
 * claimed, only otherwise is a new folder created. Unpublished rows and an
 * unconfigured root are expected conditions, not errors.
 */
export function ensureStagingDir(localId: number): EnsureResult {
    const row = getPost(localId);
    if (!row) {
        return blocked("本地行不存在。");
    }
    if (row.postId === null) {
        return blocked("这一行还没推送到站点，先推送发布再补文件。");
    }
    const workRoot = (getSetting("workRoot") ?? "").trim();
    if (workRoot === "") {
        if (!warnedRootMissing) {
            warnedRootMissing = true;
            logEvent("warn", "目录", `#${row.postId} 需要本地目录，但「自动创建文件夹位置」还没配置（本次会话只提醒这一次）`, row.postId);
        }
        return blocked("先在设置里填好自动创建文件夹位置。");
    }

    const existing = findStagingDir(row.postId);
    if (existing) {
        return { status: "claimed", dir: existing.dir, name: existing.name };
    }

    const name = stagingDirName(row.postId, row.title);
    const dir = join(workRoot, name);
    mkdirSync(dir, { recursive: true });
    logEvent("info", "目录", `#${row.postId} 已创建本地目录：${name}`, row.postId);
    return { status: "created", dir, name };
}

/** Ensure first — opening a not-yet-created folder creates it. */
export function openStagingDir(localId: number): EnsureResult {
    const result = ensureStagingDir(localId);
    if (result.dir === null) {
        return result;
    }
    const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    spawn(command, [result.dir], { detached: true, stdio: "ignore" }).unref();
    return result;
}

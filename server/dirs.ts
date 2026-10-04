/**
 * Upload staging directories: one folder per post under the configured root
 * (自动创建文件夹位置), named `{postId}-{sanitized title}`. The association
 * lives in fileserve_dirs, interlocked with the posts row by the post id;
 * the leading id is the only load-bearing part of a folder name, so manual
 * renames and title truncation never break the link.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { getPost, getSetting, getStagingDir, logEvent, upsertStagingDir } from "./db.js";

/** Whole-name budget in code points — well under the filesystem's 255-char
 * cap and comfortable inside MAX_PATH with any sane root. */
const MAX_NAME = 80;

export function stagingDirName(postId: number, title: string): string {
    const cleaned = title
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/[ .]+$/, "")
        .trim();
    const budget = MAX_NAME - String(postId).length - 1;
    // Array.from walks code points, so astral chars (emoji) are not split.
    const truncated = Array.from(cleaned)
        .slice(0, Math.max(1, budget))
        .join("")
        .trim();
    return `${postId}-${truncated === "" ? "untitled" : truncated}`;
}

export interface EnsureResult {
    status: "existing" | "claimed" | "created" | "blocked";
    dir: string | null;
    name: string | null;
    reason?: string;
}

function blocked(reason: string): EnsureResult {
    return { status: "blocked", dir: null, name: null, reason };
}

/**
 * Idempotent: a recorded association returns its folder (recreated if the
 * user removed it), a folder already carrying the post's id is claimed, and
 * only otherwise is a new folder created. Unpublished rows and an
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
        logEvent("warn", "目录", `#${row.postId} 需要上传目录，但「自动创建文件夹位置」还没配置`, row.postId);
        return blocked("先在设置里填好自动创建文件夹位置。");
    }

    const recorded = getStagingDir(row.postId);
    if (recorded) {
        if (!existsSync(recorded.dir)) {
            mkdirSync(recorded.dir, { recursive: true });
        }
        return { status: "existing", dir: recorded.dir, name: recorded.name };
    }

    // Read by leading id only: a folder the user already made (or renamed)
    // wins over a freshly minted name. The dash delimiter keeps id 50 from
    // claiming 501's folder.
    if (existsSync(workRoot)) {
        const plain = String(row.postId);
        const prefix = `${plain}-`;
        for (const entry of readdirSync(workRoot, { withFileTypes: true })) {
            if (entry.isDirectory() && (entry.name === plain || entry.name.startsWith(prefix))) {
                const dir = join(workRoot, entry.name);
                upsertStagingDir(row.postId, entry.name, dir);
                logEvent("info", "目录", `#${row.postId} 认领已有目录：${entry.name}`, row.postId);
                return { status: "claimed", dir, name: entry.name };
            }
        }
    }

    const name = stagingDirName(row.postId, row.title);
    const dir = join(workRoot, name);
    mkdirSync(dir, { recursive: true });
    upsertStagingDir(row.postId, name, dir);
    logEvent("info", "目录", `#${row.postId} 已创建上传目录：${name}`, row.postId);
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

/**
 * Local image staging: the panel copies a picked file into
 * `<data>/images/` and the post source keeps the real absolute path (as a
 * `file://` reference). Nothing is uploaded while editing — `runPush` reads
 * the file back and hands it to the site's pic bed right before the row is
 * written, so an unpublished row never occupies the pic bed and a failed push
 * does not leave a half-inserted body behind.
 *
 * Content-addressed names (first 16 hex of the sha256) make a re-drop of the
 * same file a no-op instead of a second copy, and keep the filename safe on
 * every platform.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { dataDir, logEvent } from "./db.js";
import { localImagePath, localImageSources, localImageSrc, replaceImageSources } from "../shared/image-upload.js";
import { uploadImage, WpError, type WpCreds } from "./wp.js";

export const imagesRoot = join(dataDir, "images");

/** What the panel's drop zone accepts. Raster only: a staged SVG would be
 * served from this origin and could carry script. */
const MIME_EXT: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/bmp": "bmp",
};

const EXT_MIME: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
};

/** The site's pic bed refuses anything past this; catching it here keeps the
 * failure next to the drop instead of at push time. */
export const STAGE_MAX_BYTES = 10 * 1024 * 1024;

export interface StagedImage {
    /** Absolute path on this machine — what the source references. */
    path: string;
    /** The `file://` form written into the post source. */
    src: string;
    name: string;
}

export class StageError extends Error {}

/**
 * Writes the bytes into the images directory under a content-addressed name.
 * Rejects a MIME the preview cannot serve rather than storing a file that
 * only fails later.
 */
export function stageImage(filename: string, mime: string, bytes: Uint8Array): StagedImage {
    const resolvedMime = mime.trim().toLowerCase();
    const fromMime = MIME_EXT[resolvedMime];
    const fromName = EXT_MIME[extname(filename).slice(1).toLowerCase()];
    const ext = fromMime ?? fromName;
    if (!ext) {
        throw new StageError(
            resolvedMime.startsWith("image/")
                ? `不支持这种图片格式（${resolvedMime}）：暂存只接受 PNG / JPEG / GIF / WebP / AVIF / BMP。`
                : "只接受图片文件。",
        );
    }
    if (bytes.length === 0) {
        throw new StageError("图片数据为空。");
    }
    if (bytes.length > STAGE_MAX_BYTES) {
        throw new StageError(`图片超过 ${STAGE_MAX_BYTES / 1024 / 1024}MB 上限（站点图床的限制）。`);
    }

    const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const path = join(imagesRoot, `${digest}.${ext}`);
    if (!existsSync(path)) {
        mkdirSync(imagesRoot, { recursive: true });
        writeFileSync(path, bytes);
    }
    // The real path, not the joined one: the source has to name the file the
    // OS will actually open, symlinked data dirs included.
    const real = realpathSync(path);
    return { path: real, src: localImageSrc(real), name: basename(filename) || `${digest}.${ext}` };
}

/**
 * A staged file, guarded to the images directory. Returns null for anything
 * else — including a traversed path — so the route can answer 404 without
 * ever reading outside its own folder.
 */
export function readableImage(pathOrSrc: string): { path: string; mime: string } | null {
    const target = localImagePath(pathOrSrc) ?? pathOrSrc;
    if (target.trim() === "") {
        return null;
    }
    const root = resolve(imagesRoot);
    const candidate = resolve(target);
    if (candidate !== root && !candidate.startsWith(root + sep)) {
        return null;
    }
    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
        return null;
    }
    // A symlink inside the folder must not become a read primitive either.
    const real = realpathSync(candidate);
    if (real !== root && !real.startsWith(root + sep)) {
        return null;
    }
    const mime = EXT_MIME[extname(real).slice(1).toLowerCase()];
    return mime ? { path: real, mime } : null;
}

export interface LocalImageUpload {
    /** The source with every uploaded reference replaced by the site URL. */
    content: string;
    /** reference (`file://` form) → site URL, for the write-back below. */
    uploaded: Map<string, string>;
    /** Files that could not be uploaded, already human-readable. */
    failures: string[];
}

/** Uploads every staged image the source still references, in document order. */
export async function uploadLocalImages(creds: WpCreds, content: string): Promise<LocalImageUpload> {
    const sources = localImageSources(content);
    const uploaded = new Map<string, string>();
    const failures: string[] = [];
    for (const src of sources) {
        const file = readableImage(src);
        if (file === null) {
            failures.push(`${localImagePath(src) ?? src}：文件不存在或不在本地图片目录里`);
            continue;
        }
        try {
            const result = await uploadImage(creds, basename(file.path), file.mime, readFileSync(file.path));
            uploaded.set(src, result.url);
        } catch (error) {
            failures.push(
                `${basename(file.path)}：${error instanceof WpError ? `HTTP ${error.status}：${error.message}` : String(error)}`,
            );
        }
    }
    if (uploaded.size > 0) {
        logEvent("info", "上传", `${uploaded.size} 张本地图片已上传到站点图床`);
    }
    return { content: replaceImageSources(content, uploaded), uploaded, failures };
}

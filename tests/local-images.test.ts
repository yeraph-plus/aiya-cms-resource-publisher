import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// The db module opens its file at import time — point it at a temp dir before
// anything imports it.
process.env.PUBLISHER_DATA = mkdtempSync(join(tmpdir(), "publisher-local-images-"));

// Only the site legs are replaced: the staging and serving code under test is
// the real one, and it never opens a socket by itself.
vi.mock("../server/wp.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../server/wp.js")>();
    return {
        ...actual,
        createResource: vi.fn(),
        updateResource: vi.fn(),
        uploadImage: vi.fn(),
    };
});

const { localImagePath, localImageSrc, localImageSources, replaceImageSources } = await import(
    "../shared/image-upload.js"
);
const { buildPreviewDoc } = await import("../shared/preview.js");

let app: FastifyInstance;
let wp: typeof import("../server/wp.js");
let db: typeof import("../server/db.js");

const IMAGES_ROOT = join(process.env.PUBLISHER_DATA!, "images");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

beforeAll(async () => {
    const { buildApp } = await import("../server/index.js");
    app = await buildApp();
    await app.ready();
    wp = await import("../server/wp.js");
    db = await import("../server/db.js");
    db.setSetting("siteUrl", "https://site.test");
    db.setSetting("username", "u");
    db.setSetting("appPassword", "p");
});

afterAll(async () => {
    await app.close();
});

beforeEach(() => {
    vi.mocked(wp.createResource).mockReset();
    vi.mocked(wp.updateResource).mockReset();
    vi.mocked(wp.uploadImage).mockReset();
    db.db.exec("DELETE FROM posts");
});

async function stage(bytes = PNG, mime = "image/png", filename = "图 1.png"): Promise<{ path: string; src: string; name: string }> {
    const response = await app.inject({
        method: "POST",
        url: "/api/images",
        payload: { filename, mime, dataBase64: bytes.toString("base64") },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
}

describe("the local reference form", () => {
    it("round-trips a Windows path with spaces and CJK through the src attribute", () => {
        const src = localImageSrc("D:\\图片 目录\\封面 1.png");
        expect(src).toBe("file:///D:/%E5%9B%BE%E7%89%87%20%E7%9B%AE%E5%BD%95/%E5%B0%81%E9%9D%A2%201.png");
        expect(localImagePath(src)).toBe("D:/图片 目录/封面 1.png");
    });

    it("leaves site URLs alone and does not mistake a body-relative path for a local one", () => {
        expect(localImagePath("https://site.test/a.png")).toBeNull();
        expect(localImagePath("/wp-content/uploads/a.png")).toBeNull();
        expect(localImagePath("file://server/share/a.png")).toBeNull();
    });

    it("finds every staged reference in the body and rewrites only those", () => {
        const first = "file:///D:/a.png";
        const second = "file:///D:/b.png";
        const content = [
            `<img src="${first}" alt="">`,
            `<p>正文 <img alt="x" src='${second}'></p>`,
            '<img src="https://site.test/c.png" alt="">',
        ].join("\n");

        expect(localImageSources(content)).toEqual([first, second]);

        const next = replaceImageSources(content, new Map([[first, "https://site.test/up/a.png"]]));
        expect(next).toContain("https://site.test/up/a.png");
        expect(next).toContain(second);
        expect(next).toContain("https://site.test/c.png");
    });
});

describe("POST /api/images", () => {
    it("writes the bytes into the data directory and references the real path", async () => {
        const staged = await stage();
        expect(staged.path.startsWith(IMAGES_ROOT)).toBe(true);
        expect(readFileSync(staged.path)).toEqual(PNG);
        expect(localImagePath(staged.src)?.replace(/\\/g, "/")).toBe(staged.path.replace(/\\/g, "/"));
        expect(staged.name).toBe("图 1.png");
    });

    it("stores the same bytes once, whatever the filename", async () => {
        const first = await stage(PNG, "image/png", "a.png");
        const second = await stage(PNG, "image/png", "b.png");
        expect(second.path).toBe(first.path);
    });

    it("refuses a format the preview cannot serve", async () => {
        const response = await app.inject({
            method: "POST",
            url: "/api/images",
            payload: { filename: "a.svg", mime: "image/svg+xml", dataBase64: PNG.toString("base64") },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().error).toContain("暂存只接受");
    });

    it("refuses a file past the pic bed's ceiling", async () => {
        const response = await app.inject({
            method: "POST",
            url: "/api/images",
            payload: {
                filename: "big.png",
                mime: "image/png",
                dataBase64: Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString("base64"),
            },
        });
        expect(response.statusCode).toBe(413);
    });
});

describe("GET /api/images/file", () => {
    it("serves a staged file", async () => {
        const staged = await stage();
        const response = await app.inject({
            method: "GET",
            url: `/api/images/file?path=${encodeURIComponent(staged.path)}`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toContain("image/png");
        expect(response.rawPayload).toEqual(PNG);
    });

    it("accepts the file:// form the source carries", async () => {
        const staged = await stage();
        const response = await app.inject({
            method: "GET",
            url: `/api/images/file?path=${encodeURIComponent(staged.src)}`,
        });
        expect(response.statusCode).toBe(200);
    });

    it("is not a general file reader", async () => {
        const outside = join(process.env.PUBLISHER_DATA!, "publisher.db");
        writeFileSync(join(process.env.PUBLISHER_DATA!, "secret.txt"), "nope");
        for (const path of [outside, join(process.env.PUBLISHER_DATA!, "secret.txt"), join(IMAGES_ROOT, "..", "secret.txt")]) {
            const response = await app.inject({ method: "GET", url: `/api/images/file?path=${encodeURIComponent(path)}` });
            expect(response.statusCode).toBe(404);
        }
    });
});

const item = (id: number, title: string, content: string) => ({
    id,
    status: "publish",
    title,
    content,
    date: "2026-02-02T02:02:02",
    dateGmt: "2026-02-02T02:02:02",
    modified: "2026-02-02T02:02:02",
    modifiedGmt: "2026-02-02T02:02:02",
    link: `https://site.test/resource/${id}`,
    authorId: 1,
    authorName: "站长",
    terms: null,
    fileserve: null,
});

describe("push uploads staged images", () => {
    it("uploads the file once, then writes the site URL into the row", async () => {
        vi.mocked(wp.uploadImage).mockResolvedValue({
            image: { width: 1, height: 1, mime: "image/png", title: "图 1.png" },
            url: "https://site.test/wp-content/aiya_upload_pics/2026/11/a.png",
            path: "aiya_upload_pics/2026/11/a.png",
        });
        // The site echoes what it stored, which is what a push answers with.
        vi.mocked(wp.createResource).mockImplementation(async (_creds, payload) => item(10, payload.title, payload.content));

        const staged = await stage();
        const localId = db.insertPost({
            status: "publish",
            title: "带图的一行",
            content: `<img src="${staged.src}" alt="">\n正文`,
            dirty: true,
        });

        const response = await app.inject({ method: "POST", url: "/api/push", payload: {} });
        expect(response.statusCode).toBe(200);
        expect(response.json().pushed).toBe(1);

        expect(wp.uploadImage).toHaveBeenCalledTimes(1);
        const [, sentName, sentMime, sentBytes] = vi.mocked(wp.uploadImage).mock.calls[0]!;
        expect(sentName).toContain(".png");
        expect(sentMime).toBe("image/png");
        expect(Buffer.from(sentBytes as Uint8Array)).toEqual(PNG);

        const payload = vi.mocked(wp.createResource).mock.calls[0]![1];
        expect(payload.content).toContain("https://site.test/wp-content/aiya_upload_pics/2026/11/a.png");
        expect(payload.content).not.toContain("file://");

        // Retry safety: the stored source now names the site URL, so a second
        // push does not file the same bytes again.
        expect(db.getPost(localId)?.content).not.toContain("file://");
    });

    it("fails the row instead of pushing a file:// src when the file is gone", async () => {
        const staged = await stage();
        const localId = db.insertPost({
            status: "publish",
            title: "丢图的一行",
            content: `<img src="${staged.src}" alt="">`,
            dirty: true,
        });
        const { unlinkSync } = await import("node:fs");
        unlinkSync(staged.path);

        const response = await app.inject({ method: "POST", url: "/api/push", payload: {} });
        expect(response.json().failed).toBe(1);
        expect(wp.createResource).not.toHaveBeenCalled();
        expect(db.getPost(localId)?.lastError).toContain("图片上传失败");
        expect(db.getPost(localId)?.dirty).toBe(true);
    });
});

describe("the preview document", () => {
    it("points staged images at the local route and leaves the site's images alone", () => {
        const doc = buildPreviewDoc('<img src="file:///D:/a%20b.png"><img src="https://site.test/c.png">', {
            siteUrl: "https://site.test",
            localImageUrl: (path) => `http://127.0.0.1:5175/api/images/file?path=${encodeURIComponent(path)}`,
        });
        expect(doc).toContain("http://127.0.0.1:5175/api/images/file?path=D%3A%2Fa%20b.png");
        expect(doc).toContain("https://site.test/c.png");
        expect(doc).toContain('<base href="https://site.test/">');
    });

    it("drops link targets so a click cannot navigate the preview away", () => {
        const doc = buildPreviewDoc('<p><a href="https://site.test/x">链接</a></p>', {
            siteUrl: "https://site.test",
            localImageUrl: (path) => path,
        });
        expect(doc).toContain("<a>链接</a>");
        expect(doc).not.toContain("href=\"https://site.test/x\"");
    });
});

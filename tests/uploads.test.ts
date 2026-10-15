import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Same harness as the contract suite: the db module opens its file at import
// time, so the temp dir has to be set before anything imports it.
process.env.PUBLISHER_DATA = mkdtempSync(join(tmpdir(), "publisher-uploads-"));

// undici's fetch is the only thing between the upload client and the wire, so
// it is stubbed here: the multipart leg can be inspected without a site.
const wire = vi.hoisted(() => ({
    sent: [] as { url: string; init: Record<string, unknown> }[],
    answer: async (): Promise<Response> => new Response("{}", { status: 200 }),
}));

vi.mock("undici", () => ({
    fetch: async (url: string, init: Record<string, unknown>) => {
        wire.sent.push({ url, init });
        return wire.answer();
    },
    ProxyAgent: class {},
    // Node's global FormData is undici's own implementation.
    FormData: globalThis.FormData,
}));

const { uploadImage, WpError } = await import("../server/wp.js");
const { toBase64, imageTag, prependImageTags } = await import("../shared/image-upload.js");

const CREDS = { siteUrl: "https://site.test", username: "u", appPassword: "p" };

// Shape as the site really answers it (core UploadedImage::toArray()).
const STORED = {
    image: { width: 1200, height: 800, mime: "image/png", title: "x.png" },
    url: "https://site.test/wp-content/aiya_upload_pics/2026/10/x.png",
    path: "aiya_upload_pics/2026/10/x.png",
};

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("the site upload client", () => {
    it("posts the file as multipart in the pic-bed `image` field", async () => {
        wire.sent.length = 0;
        wire.answer = async () => json(STORED);

        const result = await uploadImage(CREDS, "图片.png", "image/png", new Uint8Array([1, 2, 3]));

        expect(result.path).toBe("aiya_upload_pics/2026/10/x.png");
        expect(result.image.width).toBe(1200);

        const call = wire.sent.at(-1)!;
        expect(call.url).toBe("https://site.test/wp-json/aiya-publish/v1/uploads/image");
        expect(call.init.method).toBe("POST");

        const headers = call.init.headers as Record<string, string>;
        expect(headers.Authorization).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
        // The boundary is undici's job: a hand-set Content-Type would break it.
        expect(headers["Content-Type"]).toBeUndefined();

        const form = call.init.body as FormData;
        const entry = form.get("image") as File;
        expect(entry.name).toBe("图片.png");
        expect(entry.type).toBe("image/png");
        expect(entry.size).toBe(3);
    });

    it("carries the site's rejection status and message through", async () => {
        wire.answer = async () =>
            json({ code: "aiya_publish_upload_rejected", message: "File is too large." }, 413);

        await expect(uploadImage(CREDS, "a.png", "image/png", new Uint8Array([1]))).rejects.toMatchObject({
            status: 413,
            code: "aiya_publish_upload_rejected",
            message: "File is too large.",
        });
    });

    it("names an unreachable site instead of leaking the transport error", async () => {
        wire.answer = async () => {
            throw new Error("connect ECONNREFUSED");
        };

        const error = await uploadImage(CREDS, "a.png", "image/png", new Uint8Array([1])).catch((thrown) => thrown);
        expect(error).toBeInstanceOf(WpError);
        expect(error.status).toBe(0);
        expect(error.code).toBe("aiya_publish_unreachable");
    });
});

describe("the content helpers", () => {
    it("encodes past the argument limit a single fromCharCode would hit", () => {
        const bytes = new Uint8Array(70_000);
        for (let index = 0; index < bytes.length; index += 1) {
            bytes[index] = index % 251;
        }
        expect(toBase64(bytes.buffer)).toBe(Buffer.from(bytes).toString("base64"));
    });

    it("keeps one tag shape for the inserted image", () => {
        expect(imageTag("https://x.test/a.png")).toBe('<img src="https://x.test/a.png" alt="">');
    });

    it("puts the picked images at the very start, in order", () => {
        expect(prependImageTags("正文", ["https://x.test/a.png"])).toBe(
            '<img src="https://x.test/a.png" alt="">\n正文',
        );
        expect(prependImageTags("正文", ["https://x.test/a.png", "https://x.test/b.png"])).toBe(
            '<img src="https://x.test/a.png" alt="">\n<img src="https://x.test/b.png" alt="">\n正文',
        );
        // Nothing picked changes nothing; an empty body is just the tags.
        expect(prependImageTags("正文", [])).toBe("正文");
        expect(prependImageTags("", ["https://x.test/a.png"])).toBe('<img src="https://x.test/a.png" alt="">');
        // Dropping twice must not stack blank lines above the block.
        expect(prependImageTags("\n\n正文", ["https://x.test/b.png"])).toBe(
            '<img src="https://x.test/b.png" alt="">\n正文',
        );
    });
});

let app: FastifyInstance;
let buildApp: typeof import("../server/index.js").buildApp;

beforeAll(async () => {
    ({ buildApp } = await import("../server/index.js"));
    app = await buildApp();
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

describe("POST /api/uploads/image", () => {
    it("refuses a request with no image data", async () => {
        const empty = await app.inject({ method: "POST", url: "/api/uploads/image", payload: {} });
        expect(empty.statusCode).toBe(400);

        const blank = await app.inject({
            method: "POST",
            url: "/api/uploads/image",
            payload: { filename: "a.png", mime: "image/png", dataBase64: "" },
        });
        expect(blank.statusCode).toBe(400);
    });

    it("refuses data that is not base64 before decoding it", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/api/uploads/image",
            payload: { filename: "a.png", mime: "image/png", dataBase64: "not base64!!" },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain("base64");
    });

    it("refuses an image past the pic bed's ceiling", async () => {
        const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString("base64");
        const res = await app.inject({
            method: "POST",
            url: "/api/uploads/image",
            payload: { filename: "big.png", mime: "image/png", dataBase64: oversized },
        });
        expect(res.statusCode).toBe(413);
        expect(res.json().error).toContain("10MB");
    });

    // Order matters: this one needs the freshly-migrated db to still have no
    // site configured, and the next one configures it.
    it("refuses to upload before the site is configured", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/api/uploads/image",
            payload: { filename: "a.png", mime: "image/png", dataBase64: Buffer.from([1]).toString("base64") },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain("站点地址");
    });

    it("answers the stored image and logs the upload", async () => {
        wire.answer = async () => json(STORED);
        await app.inject({
            method: "PUT",
            url: "/api/settings",
            payload: { siteUrl: "https://site.test", username: "u", appPassword: "p" },
        });

        const res = await app.inject({
            method: "POST",
            url: "/api/uploads/image",
            payload: { filename: "x.png", mime: "image/png", dataBase64: Buffer.from([1, 2, 3]).toString("base64") },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().url).toBe(STORED.url);
        expect(res.json().path).toBe(STORED.path);
        expect(res.json().image.title).toBe("x.png");

        const logs = await app.inject({ method: "GET", url: "/api/logs?after=0&limit=50" });
        expect(
            logs.json().logs.some((entry: { scope: string; message: string }) => entry.scope === "上传"),
        ).toBe(true);
    });

    it("reports a site rejection as a 400 with the site's message", async () => {
        wire.answer = async () => json({ code: "aiya_publish_upload_rejected", message: "Only images." }, 415);

        const res = await app.inject({
            method: "POST",
            url: "/api/uploads/image",
            payload: { filename: "a.txt", mime: "text/plain", dataBase64: Buffer.from([1]).toString("base64") },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain("Only images.");
    });
});

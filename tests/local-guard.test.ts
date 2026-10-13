import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// The db module opens its file at import time — point it at a temp dir before
// the app (and everything it pulls in) is imported.
process.env.PUBLISHER_DATA = mkdtempSync(join(tmpdir(), "publisher-local-guard-"));

let app: FastifyInstance;

beforeAll(async () => {
    const { buildApp } = await import("../server/index.js");
    app = await buildApp();
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

/**
 * The tool listens on a fixed localhost port and writes to a live site, so any
 * page the user has open can reach it. Fastify parses text/plain out of the
 * box, which makes a cross-site `fetch(..., { mode: "no-cors" })` a simple
 * request: no preflight, no CORS check, and the write lands before the browser
 * hides the response. These cases pin the guard that closes that path.
 */
describe("local-only request guard", () => {
    it("refuses a cross-site Origin on a state-changing route", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/api/sync",
            headers: { origin: "https://evil.test" },
            payload: {},
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toContain("跨站");
    });

    it("refuses a cross-site text/plain POST — the no-cors simple request", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/api/push",
            headers: { origin: "https://evil.test", "content-type": "text/plain" },
            payload: "{}",
        });
        expect(res.statusCode).toBe(403);
    });

    it("refuses any request whose Host is not this machine (DNS rebinding)", async () => {
        const res = await app.inject({
            method: "GET",
            url: "/api/state",
            headers: { host: "evil.test" },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toContain("本机");
    });

    it("lets the tool's own pages through", async () => {
        // The Vite dev server proxies /api without rewriting Host, so the API
        // sees localhost:5173 from the browser on 127.0.0.1:5173.
        const proxied = await app.inject({
            method: "GET",
            url: "/api/state",
            headers: { host: "localhost:5173", origin: "http://localhost:5173" },
        });
        expect(proxied.statusCode).toBe(200);

        // No Origin at all: curl, the packaged shell, the tests themselves.
        const bare = await app.inject({ method: "GET", url: "/api/state" });
        expect(bare.statusCode).toBe(200);
    });

    it("confines the netdisk origin to the netdisk endpoints", async () => {
        const queue = await app.inject({
            method: "GET",
            url: "/api/netdisk/queue?netdisk=baidu",
            headers: { origin: "https://pan.baidu.com" },
        });
        expect(queue.statusCode).toBe(200);

        const elsewhere = await app.inject({
            method: "POST",
            url: "/api/push",
            headers: { origin: "https://pan.baidu.com" },
            payload: {},
        });
        expect(elsewhere.statusCode).toBe(403);
    });

    it("admits the userscript manager's own origin on the netdisk endpoints only", async () => {
        // GM_xmlhttpRequest does not run as the page: it presents the
        // userscript manager's extension origin (or none at all), and it skips
        // CORS. Refusing that shape would break the write-back outright.
        const queue = await app.inject({
            method: "GET",
            url: "/api/netdisk/queue?netdisk=baidu",
            headers: { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" },
        });
        expect(queue.statusCode).toBe(200);

        const result = await app.inject({
            method: "POST",
            url: "/api/netdisk/result",
            headers: { origin: "moz-extension://11111111-2222-3333-4444-555555555555" },
            payload: { localId: 1, groupId: "1", netdisk: "baidu", url: "https://pan.baidu.com/s/x", code: "k" },
        });
        // Reaches the route — which then rejects the missing row — instead of
        // being turned away by the guard.
        expect(result.statusCode).toBe(400);
        expect(result.json().error).toContain("本地行不存在");

        // The extension origin buys nothing outside the netdisk lane.
        const elsewhere = await app.inject({
            method: "GET",
            url: "/api/state",
            headers: { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" },
        });
        expect(elsewhere.statusCode).toBe(403);
    });

    it("still refuses a web page's origin on the netdisk endpoints", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/api/netdisk/result",
            headers: { origin: "https://evil.test" },
            payload: { localId: 1, groupId: "1", url: "https://x" },
        });
        expect(res.statusCode).toBe(403);
    });

    it("keeps answering the netdisk preflight", async () => {
        const preflight = await app.inject({
            method: "OPTIONS",
            url: "/api/netdisk/result",
            headers: { origin: "https://pan.baidu.com", host: "127.0.0.1:5175" },
        });
        expect(preflight.statusCode).toBe(204);
        expect(preflight.headers["access-control-allow-origin"]).toBe("https://pan.baidu.com");
    });
});

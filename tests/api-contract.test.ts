import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// The db module opens its file at import time — point it at a temp dir
// before the app (and everything it pulls in) is imported.
process.env.PUBLISHER_DATA = mkdtempSync(join(tmpdir(), "publisher-contract-"));

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

let localId = 0;

describe("local api contract", () => {
    it("saves settings with PUT /api/settings — the verb the client sends", async () => {
        const res = await app.inject({
            method: "PUT",
            url: "/api/settings",
            payload: { siteUrl: "http://localhost:8000", username: "u", appPassword: "p" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true });

        const state = await app.inject({ method: "GET", url: "/api/state" });
        expect(state.json().settings.siteUrl).toBe("http://localhost:8000");
    });

    it("rejects the wrong verb with the diagnostic 404", async () => {
        const res = await app.inject({ method: "POST", url: "/api/settings", payload: {} });
        expect(res.statusCode).toBe(404);
        expect(res.json().error).toContain("POST /api/settings");
    });

    it("creates, edits and lists rows through the exact client verbs", async () => {
        const created = await app.inject({ method: "POST", url: "/api/posts", payload: { title: "契约行" } });
        expect(created.statusCode).toBe(200);
        localId = created.json().localId;
        expect(localId).toBeGreaterThan(0);

        const saved = await app.inject({
            method: "PUT",
            url: `/api/posts/${localId}`,
            payload: {
                title: "契约行（改）",
                status: "publish",
                content: "x",
                authorId: null,
                dateLocal: "2020-01-01T00:00",
                terms: { resource_original: ["name:契约标签"] },
                fileserve: { "1": { adapter: "platform", url: "https://x" } },
            },
        });
        expect(saved.statusCode).toBe(200);
        expect(saved.json().row.dirty).toBe(true);

        // A partial patch (grid cell edit) must keep the row's terms.
        await app.inject({ method: "PUT", url: `/api/posts/${localId}`, payload: { title: "契约行（再改）" } });
        const state = await app.inject({ method: "GET", url: "/api/state" });
        const row = state.json().posts.find((post: { localId: number }) => post.localId === localId);
        expect(row.terms).toEqual({ resource_original: ["name:契约标签"] });
    });

    it("answers sync/connect/push even without a reachable site", async () => {
        const connect = await app.inject({ method: "POST", url: "/api/connect", payload: {} });
        expect([200, 502]).toContain(connect.statusCode);

        const sync = await app.inject({ method: "POST", url: "/api/sync", payload: {} });
        expect(sync.statusCode).toBe(200);

        const push = await app.inject({ method: "POST", url: "/api/push", payload: {} });
        expect(push.statusCode).toBe(200);
    });

    it("refuses reverting a row that has no confirmed snapshot, then deletes it", async () => {
        // The row was created locally and never synced/pushed: there is no
        // snapshot to revert to, and the endpoint says so.
        const revert = await app.inject({ method: "POST", url: `/api/posts/${localId}/revert` });
        expect(revert.statusCode).toBe(400);

        const removed = await app.inject({ method: "DELETE", url: `/api/posts/${localId}` });
        expect(removed.json().ok).toBe(true);
    });
});

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
            payload: { siteUrl: "http://localhost:8000", username: "u", appPassword: "p", proxyUrl: "http://127.0.0.1:7890" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true });

        const state = await app.inject({ method: "GET", url: "/api/state" });
        expect(state.json().settings.siteUrl).toBe("http://localhost:8000");
        expect(state.json().settings.proxyUrl).toBe("http://127.0.0.1:7890");
    });

    it("connect layers the typed payload over the stored settings without saving", async () => {
        // Stored: user "u"; the form overrides it — the probe uses the typed
        // value and the stored proxy, and persists nothing.
        const res = await app.inject({
            method: "POST",
            url: "/api/connect",
            payload: { username: "typed-user" },
        });
        expect(res.statusCode).toBe(200);
        // Unreachable site + bogus proxy both surface as ok:false with a message.
        expect(res.json().ok).toBe(false);
        expect(typeof res.json().error).toBe("string");

        const state = await app.inject({ method: "GET", url: "/api/state" });
        expect(state.json().settings.username).toBe("u");
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

describe("csv import", () => {
    it("previews headers, row count and the mapping guess", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/api/import/preview",
            payload: { csv: "标题,分类\n甲,漫画\n乙,动画" },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.headers).toEqual(["标题", "分类"]);
        expect(body.rowCount).toBe(2);
        expect(body.preview).toEqual([["甲", "漫画"], ["乙", "动画"]]);
        expect(body.guess.title).toBe(0);
        expect(body.guess["term:resource_category"]).toBe(1);
        expect(body.guess.author).toBeNull();
    });

    it("imports good rows into the queue and reports the bad ones per row", async () => {
        const csv = [
            "标题,正文,状态,发布时间,分类",
            "导入甲,正文,publish,2026/10/5 9:30,漫画、新标签",
            "导入乙,,future,",
            "",
        ].join("\n");
        const res = await app.inject({
            method: "POST",
            url: "/api/import/apply",
            payload: {
                csv,
                mapping: { title: 0, content: 1, status: 2, date: 3, "term:resource_category": 4 },
                defaultStatus: "draft",
                unmatchedAuthor: "error",
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().imported).toBe(1);
        expect(res.json().failed).toBe(1);
        expect(res.json().errors).toEqual([
            { row: 2, title: "导入乙", error: "定时（future）行必须携带发布时间" },
        ]);
        expect(res.json().localIds).toHaveLength(1);

        const state = await app.inject({ method: "GET", url: "/api/state" });
        const row = state.json().posts.find((post: { title: string }) => post.title === "导入甲");
        expect(row.dirty).toBe(true);
        expect(row.postId).toBeNull();
        expect(row.status).toBe("publish");
        expect(row.dateLocal).toBe("2026-10-05T09:30");
        // The refs read back through the (local_id, taxonomy, ref) index, so
        // they arrive in byte order, not insertion order — compare as sets.
        expect(row.terms.resource_category).toHaveLength(2);
        expect(row.terms.resource_category).toEqual(expect.arrayContaining(["name:漫画", "name:新标签"]));
    });

    it("refuses an import with no title column and writes nothing", async () => {
        const before = await app.inject({ method: "GET", url: "/api/state" });
        const count = before.json().posts.length;

        const res = await app.inject({
            method: "POST",
            url: "/api/import/apply",
            payload: { csv: "正文\n甲", mapping: { content: 0 }, defaultStatus: "draft", unmatchedAuthor: "error" },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain("未映射");

        const after = await app.inject({ method: "GET", url: "/api/state" });
        expect(after.json().posts.length).toBe(count);
    });

    it("refuses an import past the row cap", async () => {
        const csv = "标题\n" + Array.from({ length: 5001 }, (_, i) => `t${i}`).join("\n");
        const res = await app.inject({
            method: "POST",
            url: "/api/import/apply",
            payload: { csv, mapping: { title: 0 }, defaultStatus: "draft", unmatchedAuthor: "error" },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain("5000");
    });

    it("answers 400 when the csv text is missing or headerless", async () => {
        const empty = await app.inject({ method: "POST", url: "/api/import/preview", payload: { csv: "   " } });
        expect(empty.statusCode).toBe(400);

        const headerless = await app.inject({ method: "POST", url: "/api/import/preview", payload: { csv: "" } });
        expect(headerless.statusCode).toBe(400);

        const noBody = await app.inject({ method: "POST", url: "/api/import/apply", payload: {} });
        expect(noBody.statusCode).toBe(400);
    });
});

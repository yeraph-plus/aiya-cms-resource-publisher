import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// The db module opens its file at import time — point it at a temp dir
// before the app (and everything it pulls in) is imported.
process.env.PUBLISHER_DATA = mkdtempSync(join(tmpdir(), "publisher-logs-"));

let app: FastifyInstance;
let buildApp: typeof import("../server/index.js").buildApp;
let db: typeof import("../server/db.js");

beforeAll(async () => {
    ({ buildApp } = await import("../server/index.js"));
    app = await buildApp();
    await app.ready();
    db = await import("../server/db.js");
});

afterAll(async () => {
    await app.close();
});

describe("log registration", () => {
    it("records entries with level/scope/ref and lists them incrementally", async () => {
        db.logEvent("info", "同步", "第一条", 7);
        db.logEvent("error", "推送", "第二条", 8);
        db.logEvent("warn", "同步", "第三条");

        const res = await app.inject({ method: "GET", url: "/api/logs" });
        const logs = res.json().logs;
        expect(logs).toHaveLength(3);
        expect(logs[0]).toMatchObject({ level: "info", scope: "同步", ref: 7, message: "第一条" });
        expect(logs[1]).toMatchObject({ level: "error", scope: "推送", ref: 8 });
        expect(logs[2].ref).toBeNull();

        const inc = await app.inject({ method: "GET", url: `/api/logs?after=${logs[1].id}` });
        expect(inc.json().logs.map((entry: { message: string }) => entry.message)).toEqual(["第三条"]);
    });

    it("caps the table at 2000 entries, oldest first out", () => {
        for (let i = 0; i < 2010; i += 1) {
            db.logEvent("info", "测试", `条目 ${i}`);
        }
        const row = db.db.prepare("SELECT COUNT(*) AS n, MIN(id) AS lo, MAX(id) AS hi FROM logs").get() as {
            n: number;
            lo: number;
            hi: number;
        };
        expect(row.n).toBe(2000);
        // The survivors are one contiguous tail — no holes in the middle.
        expect(row.hi - row.lo + 1).toBe(row.n);
    });

    it("clears everything and keeps the id cursor monotonic", async () => {
        const before = await app.inject({ method: "GET", url: "/api/logs" });
        const lastId = before.json().logs[before.json().logs.length - 1].id as number;

        const res = await app.inject({ method: "POST", url: "/api/logs/clear", payload: {} });
        expect(res.json()).toMatchObject({ ok: true });
        expect(db.db.prepare("SELECT COUNT(*) AS n FROM logs").get()).toEqual({ n: 0 });

        db.logEvent("info", "测试", "清空后新条目");
        const after = await app.inject({ method: "GET", url: "/api/logs" });
        expect(after.json().logs).toHaveLength(1);
        // The id grows past the cleared entries, so an incremental client's
        // cursor never rewinds across a clear.
        expect(after.json().logs[0].id).toBeGreaterThan(lastId);
    });
});

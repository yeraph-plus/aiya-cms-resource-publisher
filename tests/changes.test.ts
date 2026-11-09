import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// The db module opens its file at import time — point it at a temp dir before
// the app (and everything it pulls in) is imported.
process.env.PUBLISHER_DATA = mkdtempSync(join(tmpdir(), "publisher-changes-"));

let app: FastifyInstance;

beforeAll(async () => {
    const { buildApp } = await import("../server/index.js");
    app = await buildApp();
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

const ingest = async (title: string): Promise<number[]> => {
    const res = await app.inject({
        method: "POST",
        url: "/api/ingest",
        payload: { rows: [{ title, content: "正文" }], source: "test" },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { localIds: number[] }).localIds;
};

const changes = async (after?: number) => {
    const url = after === undefined ? "/api/changes" : `/api/changes?after=${after}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);
    return res.json() as { cursor: number; rows: { localId: number; title: string; terms: unknown }[] };
};

/**
 * The cursor behind "an ingest landed while the tab was open". The tab cannot
 * see an agent's HTTP call, so the server has to answer "what appeared after
 * id N" — and nothing else may come along for the ride, or the client would
 * rebuild rows it is currently editing.
 */
describe("external-writer cursor", () => {
    it("starts empty with cursor 0", async () => {
        expect(await changes()).toEqual({ cursor: 0, rows: [] });
    });

    it("hands back the rows an ingest created, in local_id order", async () => {
        const localIds = await ingest("第一篇");
        const body = await changes(0);
        expect(body.cursor).toBe(localIds[0]);
        expect(body.rows.map((row) => row.localId)).toEqual(localIds);
        expect(body.rows[0]!.title).toBe("第一篇");
        // The same row shape /api/state hands out: the client splices it in.
        expect(body.rows[0]!.terms).toEqual({});
    });

    it("returns nothing once the client holds the cursor", async () => {
        const { cursor } = await changes();
        expect(await changes(cursor)).toEqual({ cursor, rows: [] });
    });

    it("reports only the rows that arrived after a lagging cursor", async () => {
        const before = (await changes()).cursor;
        const localIds = await ingest("第二篇");
        const body = await changes(before);
        expect(body.rows.map((row) => row.localId)).toEqual(localIds);
        expect(body.cursor).toBe(localIds[localIds.length - 1]);
    });

    it("ignores a cursor that is not a number", async () => {
        const res = await app.inject({ method: "GET", url: "/api/changes?after=nope" });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { cursor: number; rows: unknown[] };
        expect(body.rows.length).toBeGreaterThan(0);
        expect(body.cursor).toBeGreaterThan(0);
    });
});

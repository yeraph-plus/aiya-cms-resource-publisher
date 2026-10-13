import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { WpItem } from "../server/wp.js";

// The db module opens its file at import time — point it at a temp dir before
// the app (and everything it pulls in) is imported.
process.env.PUBLISHER_DATA = mkdtempSync(join(tmpdir(), "publisher-writeback-"));

// The site client is replaced wholesale: these tests script the answer the
// site gives, and never open a socket.
vi.mock("../server/wp.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../server/wp.js")>();
    return {
        ...actual,
        ping: vi.fn(),
        users: vi.fn(),
        taxonomies: vi.fn(),
        listResources: vi.fn(),
        createResource: vi.fn(),
        updateResource: vi.fn(),
    };
});

let app: FastifyInstance;
let wp: typeof import("../server/wp.js");
let db: typeof import("../server/db.js");

const siteItem = (id: number, title: string): WpItem => ({
    id,
    status: "publish",
    title,
    content: "站点正文",
    date: "2026-02-02T02:02:02",
    dateGmt: "2026-02-02T02:02:02",
    modified: "2026-02-02T02:02:02",
    modifiedGmt: "2026-02-02T02:02:02",
    link: `https://x.test/resource/${id}`,
    authorId: 1,
    authorName: "站长",
    terms: null,
    fileserve: null,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

beforeAll(async () => {
    const { buildApp } = await import("../server/index.js");
    app = await buildApp();
    await app.ready();
    wp = await import("../server/wp.js");
    db = await import("../server/db.js");
    db.setSetting("siteUrl", "http://writeback.test");
    db.setSetting("username", "u");
    db.setSetting("appPassword", "p");
});

afterAll(async () => {
    await app.close();
});

beforeEach(() => {
    vi.mocked(wp.createResource).mockReset();
    vi.mocked(wp.updateResource).mockReset();
    db.db.exec("DELETE FROM posts");
});

/** Runs one push whose site call is held open until the returned release runs. */
async function pushHoldingTheSiteCall() {
    let release!: (value: WpItem) => void;
    const gate = new Promise<WpItem>((resolve) => {
        release = resolve;
    });
    vi.mocked(wp.createResource).mockReturnValue(gate);
    const response = app.inject({ method: "POST", url: "/api/push", payload: {} });
    await settle();
    return { release, response };
}

/**
 * A push holds its row snapshot across a network call that can take half a
 * minute. Writing the answer back unconditionally would overwrite whatever the
 * user typed meanwhile with the pre-push text and clear `dirty`, so the edit
 * would be neither saved nor pushed again — silently gone.
 */
describe("push write-back versus edits made during the push", () => {
    it("keeps the newer local edit and leaves the row queued", async () => {
        const localId = db.insertPost({ status: "draft", title: "本地标题", content: "本地正文", dirty: true });
        const { release, response } = await pushHoldingTheSiteCall();

        // The user keeps editing that row while the request is on the wire.
        const save = await app.inject({
            method: "PUT",
            url: `/api/posts/${localId}`,
            payload: { title: "推送期间改的标题" },
        });
        expect(save.statusCode).toBe(200);

        release(siteItem(900, "站点标题"));
        const pushed = await response;
        expect(pushed.json().pushed).toBe(1);

        const after = db.getPost(localId)!;
        expect(after.title).toBe("推送期间改的标题");
        expect(after.dirty).toBe(true);
        // The site's own facts still land: they describe the site, not the draft.
        expect(after.postId).toBe(900);
        expect(after.snapshot).not.toBeNull();
        expect(after.lastPushedGmt).not.toBeNull();
    });

    it("writes the site's answer back when the row did not move", async () => {
        const localId = db.insertPost({ status: "draft", title: "本地标题", content: "本地正文", dirty: true });
        const { release, response } = await pushHoldingTheSiteCall();

        release(siteItem(901, "站点标题"));
        const pushed = await response;
        expect(pushed.json().pushed).toBe(1);

        const after = db.getPost(localId)!;
        expect(after.title).toBe("站点标题");
        expect(after.content).toBe("站点正文");
        expect(after.status).toBe("publish");
        expect(after.dirty).toBe(false);
        expect(after.postId).toBe(901);
    });
});

/**
 * The client splices single rows into the table instead of refetching the whole
 * list, so the routes that create or revert a row have to hand the stored row
 * back — a bare `{ ok: true }` would leave the table stale.
 */
describe("row-returning routes", () => {
    it("POST /api/posts returns the stored row", async () => {
        const res = await app.inject({ method: "POST", url: "/api/posts", payload: {} });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(typeof body.localId).toBe("number");
        expect(body.row.localId).toBe(body.localId);
        expect(body.row.postId).toBeNull();
        expect(body.row.dirty).toBe(true);
        expect(body.row.fileServe.status).toBe("unmounted");
    });

    it("POST /api/posts/:id/revert returns the reverted row", async () => {
        const localId = db.insertPost({ status: "draft", title: "本地标题", dirty: true });
        const { release, response } = await pushHoldingTheSiteCall();
        release(siteItem(902, "站点标题"));
        await response;

        // Dirty it again, then revert: the row must come back clean and
        // carrying the snapshot's values.
        await app.inject({ method: "PUT", url: `/api/posts/${localId}`, payload: { title: "改坏了" } });
        const reverted = await app.inject({ method: "POST", url: `/api/posts/${localId}/revert`, payload: {} });
        expect(reverted.statusCode).toBe(200);
        const body = reverted.json();
        expect(body.ok).toBe(true);
        expect(body.row.localId).toBe(localId);
        expect(body.row.title).toBe("站点标题");
        expect(body.row.dirty).toBe(false);
    });
});

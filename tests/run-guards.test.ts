import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { WpError, type WpItem, type WpPing } from "../server/wp.js";

// The db module opens its file at import time — point it at a temp dir
// before the app (and everything it pulls in) is imported.
process.env.PUBLISHER_DATA = mkdtempSync(join(tmpdir(), "publisher-guards-"));

// The site client is replaced wholesale: these tests exercise the run guards
// (breaker, mutual exclusion) against scripted outcomes, never a real socket.
// WpError stays the real class — push.ts discriminates on instanceof.
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
let buildApp: typeof import("../server/index.js").buildApp;
let wp: typeof import("../server/wp.js");
let db: typeof import("../server/db.js");

const unreachable = () => new WpError(0, "aiya_publish_unreachable", "无法连接站点：connection refused");
const forbidden = () => new WpError(403, "aiya_publish_forbidden", "HTTP 403");

const item = (id: number): WpItem => ({
    id,
    status: "draft",
    title: `站点行 ${id}`,
    content: "",
    date: "2026-01-01T00:00:00",
    dateGmt: "2026-01-01T00:00:00",
    modified: "2026-01-01T00:00:00",
    modifiedGmt: "2026-01-01T00:00:00",
    link: `https://x.test/resource/${id}`,
    authorId: 1,
    authorName: "站长",
    terms: null,
    fileserve: null,
});

const pingShape: WpPing = {
    user: { id: 1, login: "u", name: "U" },
    caps: { editPosts: true, publishPosts: true, editOthersPosts: true },
    resourceAvailable: true,
    version: "0.1.1-test",
};

beforeAll(async () => {
    ({ buildApp } = await import("../server/index.js"));
    app = await buildApp();
    await app.ready();
    wp = await import("../server/wp.js");
    db = await import("../server/db.js");
    db.setSetting("siteUrl", "http://guarded.test");
    db.setSetting("username", "u");
    db.setSetting("appPassword", "p");
});

afterAll(async () => {
    await app.close();
});

beforeEach(() => {
    vi.mocked(wp.ping).mockReset();
    vi.mocked(wp.users).mockReset();
    vi.mocked(wp.taxonomies).mockReset();
    vi.mocked(wp.listResources).mockReset();
    vi.mocked(wp.createResource).mockReset();
    vi.mocked(wp.updateResource).mockReset();
    db.db.exec("DELETE FROM posts");
});

describe("push transport breaker", () => {
    it("aborts after three consecutive transport failures and leaves the rest queued", async () => {
        const ids = Array.from({ length: 5 }, (_, i) => db.insertPost({ status: "draft", title: `行${i + 1}`, dirty: true }));
        vi.mocked(wp.createResource).mockRejectedValue(unreachable());

        const res = await app.inject({ method: "POST", url: "/api/push", payload: {} });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.pushed).toBe(0);
        expect(body.failed).toBe(3);
        expect(body.error).toContain("已中止本轮推送");
        expect(body.error).toContain("剩余 2 行");
        expect(wp.createResource).toHaveBeenCalledTimes(3);
        // The untried rows carry no error — they were skipped, not failed.
        expect(db.getPost(ids[3]!)?.lastError).toBeNull();
        expect(db.getPost(ids[4]!)?.lastError).toBeNull();
        expect(db.getPost(ids[0]!)?.lastError).toContain("无法连接站点");
    });

    it("does not abort when a 4xx proves the pipe works between transport failures", async () => {
        for (let i = 0; i < 5; i += 1) {
            db.insertPost({ status: "draft", title: `行${i + 1}`, dirty: true });
        }
        let call = 0;
        vi.mocked(wp.createResource).mockImplementation(async () => {
            call += 1;
            throw call % 2 === 1 ? unreachable() : forbidden();
        });

        const res = await app.inject({ method: "POST", url: "/api/push", payload: {} });
        const body = res.json();
        expect(body.failed).toBe(5);
        expect(body.error).toBeNull();
        expect(wp.createResource).toHaveBeenCalledTimes(5);
    });

    it("resets the counter on success", async () => {
        for (let i = 0; i < 5; i += 1) {
            db.insertPost({ status: "draft", title: `行${i + 1}`, dirty: true });
        }
        let call = 0;
        vi.mocked(wp.createResource).mockImplementation(async () => {
            call += 1;
            if (call === 3) {
                return item(101);
            }
            throw unreachable();
        });

        const res = await app.inject({ method: "POST", url: "/api/push", payload: {} });
        const body = res.json();
        expect(body.pushed).toBe(1);
        expect(body.failed).toBe(4);
        expect(body.error).toBeNull();
        expect(wp.createResource).toHaveBeenCalledTimes(5);
    });
});

describe("sync/push mutual exclusion", () => {
    it("answers 409 while a sync holds the slot, then lets the next one through", async () => {
        let release!: (value: WpPing) => void;
        const gate = new Promise<WpPing>((resolve) => {
            release = resolve;
        });
        vi.mocked(wp.ping).mockReturnValue(gate);
        vi.mocked(wp.users).mockResolvedValue([]);
        vi.mocked(wp.taxonomies).mockResolvedValue([]);
        vi.mocked(wp.listResources).mockResolvedValue({ items: [], total: 0 });

        const first = app.inject({ method: "POST", url: "/api/sync", payload: {} });
        await new Promise((resolve) => setTimeout(resolve, 25));

        const pushWhileSyncing = await app.inject({ method: "POST", url: "/api/push", payload: {} });
        expect(pushWhileSyncing.statusCode).toBe(409);
        expect(pushWhileSyncing.json().error).toContain("已有拉取在进行中");

        const syncWhileSyncing = await app.inject({ method: "POST", url: "/api/sync", payload: {} });
        expect(syncWhileSyncing.statusCode).toBe(409);

        release(pingShape);
        const firstBody = (await first).json();
        expect(firstBody.ok).toBe(true);
        expect(firstBody.fetched).toBe(0);
    });

    it("answers 409 while a push holds the slot", async () => {
        db.insertPost({ status: "draft", title: "行", dirty: true });
        let release!: (value: WpItem) => void;
        const gate = new Promise<WpItem>((resolve) => {
            release = resolve;
        });
        vi.mocked(wp.createResource).mockReturnValue(gate);

        const first = app.inject({ method: "POST", url: "/api/push", payload: {} });
        await new Promise((resolve) => setTimeout(resolve, 25));

        const syncWhilePushing = await app.inject({ method: "POST", url: "/api/sync", payload: {} });
        expect(syncWhilePushing.statusCode).toBe(409);
        expect(syncWhilePushing.json().error).toContain("已有推送在进行中");

        release(item(201));
        const firstBody = (await first).json();
        expect(firstBody.pushed).toBe(1);
    });
});

describe("sync per-item isolation", () => {
    it("skips a malformed item and keeps pulling the rest", async () => {
        vi.mocked(wp.ping).mockResolvedValue(pingShape);
        vi.mocked(wp.users).mockResolvedValue([]);
        vi.mocked(wp.taxonomies).mockResolvedValue([]);
        // The poison's terms field is not a term array — remoteToState's
        // terms.map throws inside mergeRemote, which the per-item try absorbs.
        const poison = { ...item(12), terms: { resource_category: "junk" } as unknown as null };
        vi.mocked(wp.listResources).mockResolvedValue({ items: [item(11), poison], total: 2 });

        const res = await app.inject({ method: "POST", url: "/api/sync", payload: {} });
        const body = res.json();
        expect(body.ok).toBe(true);
        expect(body.fetched).toBe(2);
        expect(body.created).toBe(1);
        expect(body.skipped).toBe(1);

        const state = await app.inject({ method: "GET", url: "/api/state" });
        const titles = state.json().posts.map((post: { title: string }) => post.title);
        expect(titles).toContain("站点行 11");
        expect(titles).not.toContain("站点行 12");
    });
});

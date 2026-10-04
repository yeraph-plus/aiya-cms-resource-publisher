import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { configDigest } from "../server/digest.js";
import { WpError, type WpItem } from "../server/wp.js";

// The db module opens its file at import time — point it at a temp dir
// before the app (and everything it pulls in) is imported.
process.env.PUBLISHER_DATA = mkdtempSync(join(tmpdir(), "publisher-pushflag-"));

// The site calls are scripted; the rest of the client stays real.
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

const item = (id: number, patch: Partial<WpItem> = {}): WpItem => ({
    id,
    status: "publish",
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
    ...patch,
});

const platformGroup = (url: string, push = true) => ({
    adapter: "platform",
    url,
    code: "a1b2",
    title: "百度网盘",
    price: 0,
    ...(push ? {} : { push: false }),
});

beforeAll(async () => {
    ({ buildApp } = await import("../server/index.js"));
    app = await buildApp();
    await app.ready();
    wp = await import("../server/wp.js");
    db = await import("../server/db.js");
    db.setSetting("siteUrl", "http://pushflag.test");
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

describe("per-group push flags in the whole-row push", () => {
    it("sends only flagged groups, with the flag field stripped", async () => {
        const localId = db.insertPost({ status: "draft", title: "行", dirty: true });
        await app.inject({
            method: "PUT",
            url: `/api/posts/${localId}`,
            payload: {
                fileserve: {
                    "1": platformGroup("https://pan.baidu.com/s/1"),
                    "2": platformGroup("https://pan.baidu.com/s/2", false),
                },
            },
        });

        vi.mocked(wp.createResource).mockResolvedValue(item(701, { fileserve: { "1": platformGroup("https://pan.baidu.com/s/1") } }));
        const res = await app.inject({ method: "POST", url: "/api/push", payload: { localIds: [localId] } });
        expect(res.json().pushed).toBe(1);

        const payload = vi.mocked(wp.createResource).mock.calls[0]![1];
        expect(payload.fileserve).toEqual({
            "1": { adapter: "platform", url: "https://pan.baidu.com/s/1", code: "a1b2", title: "百度网盘", price: 0 },
        });
        expect(JSON.stringify(payload.fileserve)).not.toContain("push");
    });

    it("a flagged incomplete group goes out as-is; the badge is the only warning", async () => {
        const localId = db.insertPost({ status: "draft", title: "行", dirty: true });
        await app.inject({
            method: "PUT",
            url: `/api/posts/${localId}`,
            payload: { fileserve: { "1": platformGroup("") } },
        });

        // The badge flags the gap…
        const state = await app.inject({ method: "GET", url: "/api/state" });
        const completion = state.json().posts.find((p: { localId: number }) => p.localId === localId).completion;
        expect(completion.status).toBe("incomplete");
        expect(completion.missing).toEqual(["组 #1 · 链接"]);

        // …but the push itself is the user's call and carries the group.
        vi.mocked(wp.createResource).mockResolvedValue(item(705));
        const res = await app.inject({ method: "POST", url: "/api/push", payload: { localIds: [localId] } });
        expect(res.json().pushed).toBe(1);
        const payload = vi.mocked(wp.createResource).mock.calls[0]![1];
        expect(payload.fileserve).toEqual({
            "1": { adapter: "platform", url: "", code: "a1b2", title: "百度网盘", price: 0 },
        });
    });

    it("unflagged drafts survive the push response write-back and a sync", async () => {
        const localId = db.insertPost({ status: "publish", title: "行", postId: 702, dirty: true });
        await app.inject({
            method: "PUT",
            url: `/api/posts/${localId}`,
            payload: {
                fileserve: {
                    "1": platformGroup("https://pan.baidu.com/s/1"),
                    "2": platformGroup("https://pan.baidu.com/s/2-draft", false),
                },
            },
        });

        // The site confirms only the flagged group.
        vi.mocked(wp.updateResource).mockResolvedValue(
            item(702, {
                link: "https://x.test/resource/702-slug/",
                fileserve: { "1": platformGroup("https://pan.baidu.com/s/1") },
            }),
        );
        const res = await app.inject({ method: "POST", url: "/api/push", payload: { localIds: [localId] } });
        expect(res.json().pushed).toBe(1);

        const after = db.getPost(localId)!;
        const stored = JSON.parse(after.fileserve!);
        expect(Object.keys(stored).sort()).toEqual(["1", "2"]);
        expect(stored["2"].push).toBe(false);
        // The baseline covers the site-confirmed subset; the badge reads "pushed".
        expect(after.fileservePushedDigest).toBe(configDigest({ "1": platformGroup("https://pan.baidu.com/s/1") }));
        const state = await app.inject({ method: "GET", url: "/api/state" });
        expect(state.json().posts.find((p: { localId: number }) => p.localId === localId).completion.status).toBe("pushed");

        // A later pull of the same item keeps the draft riding along.
        vi.mocked(wp.listResources).mockResolvedValue({
            items: [item(702, { fileserve: { "1": platformGroup("https://pan.baidu.com/s/1") } })],
            total: 1,
        });
        vi.mocked(wp.ping).mockResolvedValue({
            user: { id: 1, login: "u", name: "U" },
            caps: { editPosts: true, publishPosts: true, editOthersPosts: true },
            resourceAvailable: true,
            version: "0.1.1-test",
        });
        vi.mocked(wp.users).mockResolvedValue([]);
        vi.mocked(wp.taxonomies).mockResolvedValue([]);
        const sync = await app.inject({ method: "POST", url: "/api/sync", payload: {} });
        expect(sync.json().ok).toBe(true);
        const afterSync = JSON.parse(db.getPost(localId)!.fileserve!);
        expect(Object.keys(afterSync).sort()).toEqual(["1", "2"]);
        expect(afterSync["2"].push).toBe(false);
    });

    it("an all-draft list pushes the empty production config (clears the online list)", async () => {
        const localId = db.insertPost({ status: "publish", title: "行", postId: 703 });
        await app.inject({
            method: "PUT",
            url: `/api/posts/${localId}`,
            payload: { fileserve: { "1": platformGroup("https://pan.baidu.com/s/draft", false) } },
        });

        const state = await app.inject({ method: "GET", url: "/api/state" });
        expect(state.json().posts.find((p: { localId: number }) => p.localId === localId).completion.status).toBe("none");

        vi.mocked(wp.updateResource).mockResolvedValue(item(703));
        const res = await app.inject({ method: "POST", url: "/api/push", payload: { localIds: [localId] } });
        expect(res.json().pushed).toBe(1);
        // The site call carries the empty production config (clearing the
        // online list) — unflagged drafts never leak.
        const payload = vi.mocked(wp.updateResource).mock.calls[0]![2];
        expect(payload.fileserve).toEqual({});
    });

    it("marks the row dirty-ready after the digest drifts, then pushed again", async () => {
        const localId = db.insertPost({ status: "publish", title: "行", postId: 704 });
        await app.inject({
            method: "PUT",
            url: `/api/posts/${localId}`,
            payload: { fileserve: { "1": platformGroup("https://pan.baidu.com/s/v1") } },
        });
        vi.mocked(wp.updateResource).mockResolvedValue(
            item(704, { fileserve: { "1": platformGroup("https://pan.baidu.com/s/v1") } }),
        );
        await app.inject({ method: "POST", url: "/api/push", payload: { localIds: [localId] } });

        // Change the link: the digest no longer matches.
        await app.inject({
            method: "PUT",
            url: `/api/posts/${localId}`,
            payload: { fileserve: { "1": platformGroup("https://pan.baidu.com/s/v2") } },
        });
        const dirty = await app.inject({ method: "GET", url: "/api/state" });
        expect(dirty.json().posts.find((p: { localId: number }) => p.localId === localId).completion.status).toBe("ready");

        vi.mocked(wp.updateResource).mockResolvedValue(
            item(704, { fileserve: { "1": platformGroup("https://pan.baidu.com/s/v2") } }),
        );
        await app.inject({ method: "POST", url: "/api/push", payload: { localIds: [localId] } });
        const done = await app.inject({ method: "GET", url: "/api/state" });
        expect(done.json().posts.find((p: { localId: number }) => p.localId === localId).completion.status).toBe("pushed");
    });

    it("answers 409 while a push holds the slot and completion/push endpoints stay retired", async () => {
        db.insertPost({ status: "draft", title: "普通行", dirty: true });
        let release!: (value: WpItem) => void;
        const gate = new Promise<WpItem>((resolve) => {
            release = resolve;
        });
        vi.mocked(wp.createResource).mockReturnValue(gate);

        const first = app.inject({ method: "POST", url: "/api/push", payload: {} });
        await new Promise((resolve) => setTimeout(resolve, 25));

        const second = await app.inject({ method: "POST", url: "/api/push", payload: {} });
        expect(second.statusCode).toBe(409);

        const retired = await app.inject({ method: "POST", url: "/api/completion/push", payload: {} });
        expect(retired.statusCode).toBe(404);

        release(item(201));
        expect((await first).json().pushed).toBe(1);
    });

    it("a transport failure streak still aborts the run", async () => {
        for (let i = 0; i < 4; i += 1) {
            const localId = db.insertPost({ status: "draft", title: `行${i}`, dirty: true });
            await app.inject({
                method: "PUT",
                url: `/api/posts/${localId}`,
                payload: { fileserve: { "1": platformGroup("https://pan.baidu.com/s/x") } },
            });
        }
        vi.mocked(wp.createResource).mockRejectedValue(new WpError(0, "aiya_publish_unreachable", "无法连接站点"));

        const res = await app.inject({ method: "POST", url: "/api/push", payload: {} });
        const body = res.json();
        expect(body.pushed).toBe(0);
        expect(body.failed).toBe(3);
        expect(body.error).toContain("已中止本轮推送");
    });
});

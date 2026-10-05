import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { WpError, type WpItem } from "../server/wp.js";

// The db module opens its file at import time — point it at a temp dir
// before the app (and everything it pulls in) is imported.
process.env.PUBLISHER_DATA = mkdtempSync(join(tmpdir(), "publisher-netdiskfield-"));

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

const platformGroup = (url: string, netdisk?: string) => ({
    adapter: "platform",
    url,
    code: "a1b2",
    title: "百度网盘",
    price: 0,
    ...(netdisk !== undefined ? { netdisk } : {}),
});

beforeAll(async () => {
    ({ buildApp } = await import("../server/index.js"));
    app = await buildApp();
    await app.ready();
    wp = await import("../server/wp.js");
    db = await import("../server/db.js");
    db.setSetting("siteUrl", "http://netdiskfield.test");
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

describe("the netdisk field in the whole-row push", () => {
    it("strips the netdisk field from the payload and re-attaches it on write-back", async () => {
        const localId = db.insertPost({ status: "publish", title: "行", postId: 801, dirty: true });
        await app.inject({
            method: "PUT",
            url: `/api/posts/${localId}`,
            payload: {
                fileserve: {
                    "1": platformGroup("https://pan.baidu.com/s/1", "baidu"),
                    "2": platformGroup("https://pan.quark.cn/s/2", "quark"),
                },
            },
        });

        vi.mocked(wp.updateResource).mockResolvedValue(
            item(801, {
                fileserve: {
                    "1": platformGroup("https://pan.baidu.com/s/1"),
                    "2": platformGroup("https://pan.quark.cn/s/2"),
                },
            }),
        );
        const res = await app.inject({ method: "POST", url: "/api/push", payload: { localIds: [localId] } });
        expect(res.json().pushed).toBe(1);

        // The payload carries both groups with no local field.
        const payload = vi.mocked(wp.updateResource).mock.calls[0]![2];
        expect(payload.fileserve).toEqual({
            "1": { adapter: "platform", url: "https://pan.baidu.com/s/1", code: "a1b2", title: "百度网盘", price: 0 },
            "2": { adapter: "platform", url: "https://pan.quark.cn/s/2", code: "a1b2", title: "百度网盘", price: 0 },
        });
        expect(JSON.stringify(payload.fileserve)).not.toContain("netdisk");

        // The write-back re-attaches the ownership fields.
        const stored = JSON.parse(db.getPost(localId)!.fileserve!);
        expect(stored["1"].netdisk).toBe("baidu");
        expect(stored["2"].netdisk).toBe("quark");
    });

    it("empty links go out as-is; the sync keeps the ownership fields", async () => {
        const localId = db.insertPost({ status: "publish", title: "行", postId: 802 });
        await app.inject({
            method: "PUT",
            url: `/api/posts/${localId}`,
            payload: { fileserve: { "1": platformGroup("", "baidu") } },
        });

        vi.mocked(wp.ping).mockResolvedValue({
            user: { id: 1, login: "u", name: "U" },
            caps: { editPosts: true, publishPosts: true, editOthersPosts: true },
            resourceAvailable: true,
            version: "0.1.1-test",
        });
        vi.mocked(wp.users).mockResolvedValue([]);
        vi.mocked(wp.taxonomies).mockResolvedValue([]);
        vi.mocked(wp.listResources).mockResolvedValue({
            items: [item(802, { fileserve: { "1": platformGroup("") } })],
            total: 1,
        });
        const sync = await app.inject({ method: "POST", url: "/api/sync", payload: {} });
        expect(sync.json().ok).toBe(true);
        const stored = JSON.parse(db.getPost(localId)!.fileserve!);
        expect(stored["1"].netdisk).toBe("baidu");

        const state = await app.inject({ method: "GET", url: "/api/state" });
        const row = state.json().posts.find((p: { localId: number }) => p.localId === localId);
        expect(row.fileServe.status).toBe("fillable");
        expect(row.fileServe.items).toEqual([{ groupId: "1", label: "百度网盘" }]);
    });

    it("fills all groups regardless of tags; a filled list reads complete", async () => {
        const localId = db.insertPost({ status: "publish", title: "行", postId: 803 });
        await app.inject({
            method: "PUT",
            url: `/api/posts/${localId}`,
            payload: {
                fileserve: {
                    "1": platformGroup("https://pan.baidu.com/s/1", "baidu"),
                    "2": platformGroup("https://pan.quark.cn/s/2", "quark"),
                },
            },
        });

        const state = await app.inject({ method: "GET", url: "/api/state" });
        expect(state.json().posts.find((p: { localId: number }) => p.localId === localId).fileServe.status).toBe("complete");
    });

    it("unmounted rows badge 无文件挂载; published-without-list too", async () => {
        db.insertPost({ status: "draft", title: "未上线无列表" });
        db.insertPost({ status: "publish", title: "线上无列表", postId: 804 });

        const state = await app.inject({ method: "GET", url: "/api/state" });
        const states = state.json().posts.map((p: { fileServe: { status: string } }) => p.fileServe.status);
        expect(states).toEqual(["unmounted", "unmounted"]);
    });

    it("answers 409 while a push holds the slot and a transport streak aborts", async () => {
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
        release(item(201));
        expect((await first).json().pushed).toBe(1);

        for (let i = 0; i < 3; i += 1) {
            const localId = db.insertPost({ status: "draft", title: `行${i}`, dirty: true });
            await app.inject({
                method: "PUT",
                url: `/api/posts/${localId}`,
                payload: { fileserve: { "1": platformGroup("https://pan.baidu.com/s/x") } },
            });
        }
        vi.mocked(wp.createResource).mockRejectedValue(new WpError(0, "aiya_publish_unreachable", "无法连接站点"));
        const res = await app.inject({ method: "POST", url: "/api/push", payload: {} });
        expect(res.json().failed).toBe(3);
        expect(res.json().error).toContain("已中止本轮推送");
    });
});

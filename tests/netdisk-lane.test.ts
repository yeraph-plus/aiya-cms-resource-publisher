import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// The db module opens its file at import time — point it at a temp dir
// before the app (and everything it pulls in) is imported.
process.env.PUBLISHER_DATA = mkdtempSync(join(tmpdir(), "publisher-netdisk-"));

let app: FastifyInstance;
let buildApp: typeof import("../server/index.js").buildApp;
let db: typeof import("../server/db.js");

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
    db = await import("../server/db.js");
    db.setSetting("siteUrl", "http://netdisk.test");
    db.setSetting("username", "u");
    db.setSetting("appPassword", "p");
});

afterAll(async () => {
    await app.close();
});

beforeEach(() => {
    db.db.exec("DELETE FROM posts");
});

describe("netdisk queue", () => {
    it("lists only published rows' empty platform groups, with the staging dir name", async () => {
        const filled = db.insertPost({
            status: "publish",
            title: "已完成",
            postId: 501,
            fileserve: JSON.stringify({ "1": platformGroup("https://pan.baidu.com/s/x") }),
        });
        const draft = db.insertPost({
            status: "publish",
            title: "测试 文章",
            postId: 502,
            fileserve: JSON.stringify({
                "1": platformGroup("", false),
                "2": platformGroup("https://pan.baidu.com/s/y"),
            }),
        });
        db.insertPost({ status: "draft", title: "未上线", fileserve: JSON.stringify({ "1": platformGroup("") }) });
        db.insertPost({ status: "publish", title: "无列表", postId: 503 });

        const res = await app.inject({ method: "GET", url: "/api/netdisk/queue" });
        expect(res.statusCode).toBe(200);
        const queue = res.json().queue;
        expect(queue).toHaveLength(1);
        expect(queue[0]).toMatchObject({
            localId: draft,
            postId: 502,
            groupId: "1",
            dirName: "00502-测试 文章",
            title: "测试 文章",
            groupTitle: "百度网盘",
        });
        // A replayed fill finds nothing: the filled row is not in the queue.
        expect(queue.every((item: { localId: number }) => item.localId !== filled)).toBe(true);
    });

    it("exposes CORS to the netdisk origin and answers the preflight", async () => {
        const res = await app.inject({ method: "GET", url: "/api/netdisk/queue" });
        expect(res.headers["access-control-allow-origin"]).toBe("https://pan.baidu.com");

        const preflight = await app.inject({ method: "OPTIONS", url: "/api/netdisk/result" });
        expect(preflight.statusCode).toBe(204);
        expect(preflight.headers["access-control-allow-origin"]).toBe("https://pan.baidu.com");
        expect(preflight.headers["access-control-allow-headers"]).toContain("Content-Type");
    });
});

describe("netdisk result write-back", () => {
    it("fills the link, flags the group for push, and marks the row dirty", async () => {
        const localId = db.insertPost({
            status: "publish",
            title: "行",
            postId: 510,
            fileserve: JSON.stringify({ "1": platformGroup("", false) }),
        });

        const res = await app.inject({
            method: "POST",
            url: "/api/netdisk/result",
            payload: { localId, groupId: "1", url: " https://pan.baidu.com/s/1abc ", code: " a9k2 " },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().ok).toBe(true);

        const after = db.getPost(localId)!;
        const stored = JSON.parse(after.fileserve!);
        expect(stored["1"]).toEqual({
            adapter: "platform",
            url: "https://pan.baidu.com/s/1abc",
            code: "a9k2",
            title: "百度网盘",
            price: 0,
            push: true,
        });
        expect(after.dirty).toBe(true);
    });

    it("refuses missing rows/groups, non-platform groups, and overwriting a filled group", async () => {
        const localId = db.insertPost({
            status: "publish",
            title: "行",
            postId: 511,
            fileserve: JSON.stringify({
                "1": platformGroup("https://pan.baidu.com/s/live"),
                "2": { adapter: "openlist_list", path: "/x", password: "", per_page: 0, title: "", price: 0 },
            }),
        });

        const gone = await app.inject({ method: "POST", url: "/api/netdisk/result", payload: { localId: 999, groupId: "1", url: "https://x" } });
        expect(gone.statusCode).toBe(400);
        expect(gone.json().error).toContain("本地行不存在");

        const noGroup = await app.inject({ method: "POST", url: "/api/netdisk/result", payload: { localId, groupId: "9", url: "https://x" } });
        expect(noGroup.json().error).toContain("组 #9 不存在");

        const notPlatform = await app.inject({ method: "POST", url: "/api/netdisk/result", payload: { localId, groupId: "2", url: "https://x" } });
        expect(notPlatform.json().error).toContain("不是网盘链接组");

        const replay = await app.inject({ method: "POST", url: "/api/netdisk/result", payload: { localId, groupId: "1", url: "https://x" } });
        expect(replay.statusCode).toBe(400);
        expect(replay.json().error).toContain("拒绝覆盖");

        const empty = await app.inject({ method: "POST", url: "/api/netdisk/result", payload: { localId, groupId: "1", url: "   " } });
        expect(empty.json().error).toContain("分享链接为空");

        const missing = await app.inject({ method: "POST", url: "/api/netdisk/result", payload: { url: "https://x" } });
        expect(missing.statusCode).toBe(400);
        expect(missing.json().error).toContain("localId");

        // None of the refusals touched the stored config.
        expect(JSON.parse(db.getPost(localId)!.fileserve!)["1"].url).toBe("https://pan.baidu.com/s/live");
    });
});

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
    it("hands each pipeline only its own empty-link groups", async () => {
        const baiduRow = db.insertPost({
            status: "publish",
            title: "测试 文章",
            postId: 502,
            fileserve: JSON.stringify({
                "1": platformGroup("", "baidu"),
                "2": platformGroup("https://pan.baidu.com/s/y", "baidu"),
            }),
        });
        db.insertPost({
            status: "publish",
            title: "夸克行",
            postId: 503,
            fileserve: JSON.stringify({ "1": platformGroup("", "quark") }),
        });
        db.insertPost({ status: "draft", title: "未上线", fileserve: JSON.stringify({ "1": platformGroup("", "baidu") }) });
        db.insertPost({ status: "publish", title: "无列表", postId: 504 });

        const res = await app.inject({ method: "GET", url: "/api/netdisk/queue?netdisk=baidu" });
        expect(res.statusCode).toBe(200);
        const queue = res.json().queue;
        // The untagged empty group counts as baidu; quark's is invisible here.
        expect(queue).toHaveLength(1);
        expect(queue[0]).toMatchObject({
            localId: baiduRow,
            postId: 502,
            groupId: "1",
            netdisk: "baidu",
            dirName: "000502-测试 文章",
            title: "测试 文章",
            groupTitle: "百度网盘",
        });

        // The quark pipeline asks for its own lane and gets only its group.
        const quark = await app.inject({ method: "GET", url: "/api/netdisk/queue?netdisk=quark" });
        expect(quark.json().queue).toHaveLength(1);
        expect(quark.json().queue[0].postId).toBe(503);
    });

    it("exposes CORS to the netdisk origin and answers the preflight", async () => {
        const res = await app.inject({ method: "GET", url: "/api/netdisk/queue?netdisk=baidu" });
        expect(res.headers["access-control-allow-origin"]).toBe("https://pan.baidu.com");

        const preflight = await app.inject({ method: "OPTIONS", url: "/api/netdisk/result" });
        expect(preflight.statusCode).toBe(204);
        expect(preflight.headers["access-control-allow-origin"]).toBe("https://pan.baidu.com");
        expect(preflight.headers["access-control-allow-headers"]).toContain("Content-Type");
    });
});

describe("netdisk result write-back", () => {
    it("fills the link, defaults the title from the netdisk, and marks the row dirty", async () => {
        const localId = db.insertPost({
            status: "publish",
            title: "行",
            postId: 510,
            fileserve: JSON.stringify({ "1": platformGroup("", "baidu") }),
        });

        const res = await app.inject({
            method: "POST",
            url: "/api/netdisk/result",
            payload: { localId, groupId: "1", netdisk: "baidu", url: " https://pan.baidu.com/s/1abc ", code: " a9k2 " },
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
            netdisk: "baidu",
        });
        expect(after.dirty).toBe(true);
    });

    it("refuses missing rows/groups, cross-pipeline writes, and overwriting a filled group", async () => {
        const localId = db.insertPost({
            status: "publish",
            title: "行",
            postId: 511,
            fileserve: JSON.stringify({
                "1": platformGroup("https://pan.baidu.com/s/live", "baidu"),
                "2": platformGroup("", "quark"),
                "3": { adapter: "openlist_list", path: "/x", password: "", per_page: 0, title: "", price: 0 },
            }),
        });

        const gone = await app.inject({ method: "POST", url: "/api/netdisk/result", payload: { localId: 999, groupId: "1", netdisk: "baidu", url: "https://x" } });
        expect(gone.json().error).toContain("本地行不存在");

        const noGroup = await app.inject({ method: "POST", url: "/api/netdisk/result", payload: { localId, groupId: "9", netdisk: "baidu", url: "https://x" } });
        expect(noGroup.json().error).toContain("组 #9 不存在");

        const notPlatform = await app.inject({ method: "POST", url: "/api/netdisk/result", payload: { localId, groupId: "3", netdisk: "baidu", url: "https://x" } });
        expect(notPlatform.json().error).toContain("不是网盘链接组");

        // The quark group refuses the baidu script — pipelines cannot clobber.
        const cross = await app.inject({ method: "POST", url: "/api/netdisk/result", payload: { localId, groupId: "2", netdisk: "baidu", url: "https://x" } });
        expect(cross.json().error).toContain("夸克网盘 管线");

        const replay = await app.inject({ method: "POST", url: "/api/netdisk/result", payload: { localId, groupId: "1", netdisk: "baidu", url: "https://x" } });
        expect(replay.json().error).toContain("拒绝覆盖");

        const empty = await app.inject({ method: "POST", url: "/api/netdisk/result", payload: { localId, groupId: "1", netdisk: "baidu", url: "   " } });
        expect(empty.json().error).toContain("分享链接为空");

        const missing = await app.inject({ method: "POST", url: "/api/netdisk/result", payload: { url: "https://x" } });
        expect(missing.statusCode).toBe(400);
        expect(missing.json().error).toContain("localId");

        // None of the refusals touched the stored config.
        expect(JSON.parse(db.getPost(localId)!.fileserve!)["1"].url).toBe("https://pan.baidu.com/s/live");
    });
});

/**
 * The reported failure: the link the script created does not stick. Nothing
 * locked the row — the lane writes straight to the database, so an open detail
 * panel never hears about the fill and keeps a draft whose link is still empty.
 * Saving any field of that row then put the empty draft back and destroyed the
 * share, which reads as "the script could not write back".
 */
describe("netdisk fill versus a panel that was already open", () => {
    const filled = "https://pan.baidu.com/s/filled?pwd=a9k2";

    async function fill(localId: number): Promise<void> {
        const res = await app.inject({
            method: "POST",
            url: "/api/netdisk/result",
            payload: { localId, groupId: "1", netdisk: "baidu", url: filled, code: "a9k2" },
        });
        expect(res.json().ok).toBe(true);
    }

    it("keeps the fill when the panel saves another field with its pre-fill draft", async () => {
        const localId = db.insertPost({
            status: "publish",
            title: "行",
            postId: 520,
            fileserve: JSON.stringify({ "1": platformGroup("", "baidu") }),
        });
        // What the panel loaded and is still showing while the script runs.
        const base = db.getPost(localId)!.fileserve!;
        const draft = JSON.parse(base) as Record<string, unknown>;

        await fill(localId);

        const res = await app.inject({
            method: "PUT",
            url: `/api/posts/${localId}`,
            payload: { title: "改过的标题", fileserve: draft, fileserveBase: base },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().fileserveMoved).toBe(true);
        // The user's own edit still lands...
        expect(res.json().row.title).toBe("改过的标题");
        // ...and the link the script created survives.
        expect(JSON.parse(db.getPost(localId)!.fileserve!)["1"].url).toBe(filled);
    });

    it("keeps a group the user added while the fill won its own group", async () => {
        const localId = db.insertPost({
            status: "publish",
            title: "行",
            postId: 521,
            fileserve: JSON.stringify({ "1": platformGroup("", "baidu") }),
        });
        const base = db.getPost(localId)!.fileserve!;
        const draft = { ...(JSON.parse(base) as Record<string, unknown>), "2": platformGroup("", "quark") };

        await fill(localId);

        const res = await app.inject({
            method: "PUT",
            url: `/api/posts/${localId}`,
            payload: { fileserve: draft, fileserveBase: base },
        });
        expect(res.json().fileserveMoved).toBe(true);
        const stored = JSON.parse(db.getPost(localId)!.fileserve!) as Record<string, { url: string; netdisk?: string }>;
        expect(stored["1"]!.url).toBe(filled);
        expect(stored["2"]!.netdisk).toBe("quark");
    });

    it("leaves the fill alone for a plain cell edit that carries no file list", async () => {
        const localId = db.insertPost({
            status: "publish",
            title: "行",
            postId: 522,
            fileserve: JSON.stringify({ "1": platformGroup("", "baidu") }),
        });
        await fill(localId);

        const res = await app.inject({ method: "PUT", url: `/api/posts/${localId}`, payload: { title: "表格里改的" } });
        expect(res.statusCode).toBe(200);
        expect(res.json().fileserveMoved).toBe(false);
        expect(JSON.parse(db.getPost(localId)!.fileserve!)["1"].url).toBe(filled);
    });
});

/**
 * The app has no other way to hear about a fill: the script is a different
 * client and the write lands in the database directly.
 */
describe("netdisk applied cursor", () => {
    it("reports each fill once, with the whole row", async () => {
        const localId = db.insertPost({
            status: "publish",
            title: "行",
            postId: 530,
            fileserve: JSON.stringify({ "1": platformGroup("", "baidu") }),
        });
        const start = await app.inject({ method: "GET", url: "/api/netdisk/applied?after=0" });

        await app.inject({
            method: "POST",
            url: "/api/netdisk/result",
            payload: { localId, groupId: "1", netdisk: "baidu", url: "https://pan.baidu.com/s/n1", code: "k1" },
        });

        const applied = await app.inject({ method: "GET", url: `/api/netdisk/applied?after=${start.json().cursor}` });
        expect(applied.statusCode).toBe(200);
        const rows = applied.json().rows;
        expect(rows.map((row: { localId: number }) => row.localId)).toEqual([localId]);
        expect(rows[0].fileserveParsed["1"].url).toBe("https://pan.baidu.com/s/n1");
        // The badge ground truth travels with it: the group is filled now.
        expect(rows[0].fileServe.status).toBe("complete");

        // Nothing new since that cursor.
        const again = await app.inject({ method: "GET", url: `/api/netdisk/applied?after=${applied.json().cursor}` });
        expect(again.json().rows).toEqual([]);
    });
});

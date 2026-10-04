import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// The db module opens its file at import time — point it at a temp dir
// before the app (and everything it pulls in) is imported. No static value
// import may reach server/dirs.js or server/db.js: ESM hoists imports above
// the env assignment, and the db would silently open the real publisher.db.
process.env.PUBLISHER_DATA = mkdtempSync(join(tmpdir(), "publisher-dirs-"));

let app: FastifyInstance;
let buildApp: typeof import("../server/index.js").buildApp;
let db: typeof import("../server/db.js");
let stagingDirName: typeof import("../server/dirs.js").stagingDirName;
let workRoot: string;

beforeAll(async () => {
    ({ buildApp } = await import("../server/index.js"));
    app = await buildApp();
    await app.ready();
    db = await import("../server/db.js");
    ({ stagingDirName } = await import("../server/dirs.js"));
    db.setSetting("siteUrl", "http://dirs.test");
    db.setSetting("username", "u");
    db.setSetting("appPassword", "p");
});

afterAll(async () => {
    await app.close();
});

beforeEach(() => {
    db.db.exec("DELETE FROM posts");
    db.db.exec("DELETE FROM fileserve_dirs");
    workRoot = mkdtempSync(join(tmpdir(), "publisher-dirs-root-"));
    db.setSetting("workRoot", workRoot);
});

describe("staging dir naming", () => {
    it("sanitizes illegal characters into spaces and keeps CJK", () => {
        expect(stagingDirName(501, 'A/B:C*D?"E<F>G|H')).toBe("501-A B C D E F G H");
        expect(stagingDirName(501, "测试 文章")).toBe("501-测试 文章");
    });

    it("truncates the title to the budget at code points", () => {
        const name = stagingDirName(12345, "长".repeat(200));
        // 80 budget - 5 (id) - 1 (dash) = 74 title code points.
        expect(Array.from(name)).toHaveLength(80);
        expect(name.startsWith("12345-")).toBe(true);
    });

    it("strips trailing dots and spaces, and falls back on an empty title", () => {
        expect(stagingDirName(7, "标题...")).toBe("7-标题");
        expect(stagingDirName(7, "   ")).toBe("7-untitled");
    });
});

describe("staging dir ensure", () => {
    it("creates the folder, records it, and is idempotent", async () => {
        const localId = db.insertPost({ status: "publish", title: "测试 文章", postId: 501 });

        const res = await app.inject({ method: "POST", url: "/api/fileserve-dir/ensure", payload: { localId } });
        const body = res.json();
        expect(body.status).toBe("created");
        expect(body.name).toBe("501-测试 文章");
        expect(existsSync(join(workRoot, "501-测试 文章"))).toBe(true);

        const info = await app.inject({ method: "GET", url: `/api/fileserve-dir/${localId}` });
        expect(info.json().name).toBe("501-测试 文章");

        const again = await app.inject({ method: "POST", url: "/api/fileserve-dir/ensure", payload: { localId } });
        expect(again.json().status).toBe("existing");
        expect(db.db.prepare("SELECT COUNT(*) AS n FROM fileserve_dirs").get()).toEqual({ n: 1 });
    });

    it("claims an existing folder by its leading id, and only the exact id", async () => {
        const localId = db.insertPost({ status: "publish", title: "测试 文章", postId: 502 });
        mkdirSync(join(workRoot, "502-renamed-by-hand"));
        // A longer id sharing the digit prefix must not be claimed: the dash
        // delimiter is what makes the leading id unambiguous.
        mkdirSync(join(workRoot, "5025-similar"));

        const res = await app.inject({ method: "POST", url: "/api/fileserve-dir/ensure", payload: { localId } });
        const body = res.json();
        expect(body.status).toBe("claimed");
        expect(body.name).toBe("502-renamed-by-hand");
        expect(db.db.prepare("SELECT name FROM fileserve_dirs").get()).toEqual({ name: "502-renamed-by-hand" });
    });

    it("blocks unpublished rows and an unconfigured root without touching disk", async () => {
        const local = db.insertPost({ status: "draft", title: "未上线" });
        const res = await app.inject({ method: "POST", url: "/api/fileserve-dir/ensure", payload: { localId: local } });
        expect(res.json().status).toBe("blocked");
        expect(res.json().reason).toContain("先推送发布");

        const published = db.insertPost({ status: "publish", title: "行", postId: 503 });
        db.setSetting("workRoot", "");
        const res2 = await app.inject({ method: "POST", url: "/api/fileserve-dir/ensure", payload: { localId: published } });
        expect(res2.json().status).toBe("blocked");
        expect(res2.json().reason).toContain("自动创建文件夹位置");
        expect(existsSync(join(workRoot, "503-行"))).toBe(false);
    });

    it("drops the association when the local row is deleted, and the folder stays", async () => {
        const localId = db.insertPost({ status: "publish", title: "行", postId: 504 });
        await app.inject({ method: "POST", url: "/api/fileserve-dir/ensure", payload: { localId } });
        await app.inject({ method: "DELETE", url: `/api/posts/${localId}` });
        expect(db.db.prepare("SELECT COUNT(*) AS n FROM fileserve_dirs").get()).toEqual({ n: 0 });
        expect(existsSync(join(workRoot, "504-行"))).toBe(true);
    });

    it("answers 400 on open when the prerequisites are missing", async () => {
        const local = db.insertPost({ status: "draft", title: "未上线" });
        const res = await app.inject({ method: "POST", url: "/api/fileserve-dir/open", payload: { localId: local } });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain("先推送发布");
    });
});

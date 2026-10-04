import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { stagingDirName } from "../shared/staging-name.js";

// The db module opens its file at import time — point it at a temp dir
// before the app (and everything it pulls in) is imported. No static value
// import may reach server/dirs.js or server/db.js: ESM hoists imports above
// the env assignment, and the db would silently open the real publisher.db.
process.env.PUBLISHER_DATA = mkdtempSync(join(tmpdir(), "publisher-dirs-"));

let app: FastifyInstance;
let buildApp: typeof import("../server/index.js").buildApp;
let db: typeof import("../server/db.js");
let workRoot: string;

beforeAll(async () => {
    ({ buildApp } = await import("../server/index.js"));
    app = await buildApp();
    await app.ready();
    db = await import("../server/db.js");
    db.setSetting("siteUrl", "http://dirs.test");
    db.setSetting("username", "u");
    db.setSetting("appPassword", "p");
});

afterAll(async () => {
    await app.close();
});

beforeEach(() => {
    db.db.exec("DELETE FROM posts");
    workRoot = mkdtempSync(join(tmpdir(), "publisher-dirs-root-"));
    db.setSetting("workRoot", workRoot);
});

describe("staging dir naming", () => {
    it("pads the id to 5 digits, sanitizes illegal characters and keeps CJK", () => {
        expect(stagingDirName(501, 'A/B:C*D?"E<F>G|H')).toBe("00501-A B C D E F G H");
        expect(stagingDirName(501, "测试 文章")).toBe("00501-测试 文章");
        expect(stagingDirName(7, "标题")).toBe("00007-标题");
        // Ids beyond five digits are not truncated.
        expect(stagingDirName(123456, "标题").startsWith("123456-")).toBe(true);
    });

    it("truncates the title to the budget at code points", () => {
        const name = stagingDirName(12345, "长".repeat(200));
        // 80 budget - 5 (id) - 1 (dash) = 74 title code points.
        expect(Array.from(name)).toHaveLength(80);
        expect(name.startsWith("12345-")).toBe(true);
    });

    it("strips trailing dots and spaces, and falls back on an empty title", () => {
        expect(stagingDirName(7, "标题...")).toBe("00007-标题");
        expect(stagingDirName(7, "   ")).toBe("00007-untitled");
    });
});

describe("staging dir ensure", () => {
    it("creates the padded folder on first call and claims it on every later one", async () => {
        const localId = db.insertPost({ status: "publish", title: "测试 文章", postId: 501 });

        const res = await app.inject({ method: "POST", url: "/api/fileserve-dir/ensure", payload: { localId } });
        const body = res.json();
        expect(body.status).toBe("created");
        expect(body.name).toBe("00501-测试 文章");
        expect(existsSync(join(workRoot, "00501-测试 文章"))).toBe(true);

        const again = await app.inject({ method: "POST", url: "/api/fileserve-dir/ensure", payload: { localId } });
        expect(again.json().status).toBe("claimed");
        expect(again.json().name).toBe("00501-测试 文章");

        // The lookup endpoint reads the filesystem, nothing else.
        const info = await app.inject({ method: "GET", url: `/api/fileserve-dir/${localId}` });
        expect(info.json().name).toBe("00501-测试 文章");
    });

    it("claims only the exact padded id; longer ids and other shapes never match", async () => {
        const localId = db.insertPost({ status: "publish", title: "测试 文章", postId: 502 });
        mkdirSync(join(workRoot, "00502-renamed-by-hand"));
        // A longer id sharing the digits must not be claimed, and the legacy
        // unpadded shape is not recognized either — the padded form is the
        // only name this feature has ever had.
        mkdirSync(join(workRoot, "5025-similar"));
        mkdirSync(join(workRoot, "502-legacy"));

        const res = await app.inject({ method: "POST", url: "/api/fileserve-dir/ensure", payload: { localId } });
        const body = res.json();
        expect(body.status).toBe("claimed");
        expect(body.name).toBe("00502-renamed-by-hand");
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
        expect(existsSync(join(workRoot, "00503-行"))).toBe(false);
    });

    it("records nothing: deleting the row leaves the folder and no trace in the db", async () => {
        const localId = db.insertPost({ status: "publish", title: "行", postId: 504 });
        await app.inject({ method: "POST", url: "/api/fileserve-dir/ensure", payload: { localId } });
        await app.inject({ method: "DELETE", url: `/api/posts/${localId}` });
        expect(existsSync(join(workRoot, "00504-行"))).toBe(true);
        // The staging dirs are not modelled in SQL at all — no table to hold
        // them means nothing can go stale.
        const tables = (db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
            (entry) => entry.name,
        );
        expect(tables).not.toContain("fileserve_dirs");

        // A future row for the same post id claims the folder by prefix.
        const again = db.insertPost({ status: "publish", title: "行", postId: 504 });
        const res = await app.inject({ method: "POST", url: "/api/fileserve-dir/ensure", payload: { localId: again } });
        expect(res.json()).toMatchObject({ status: "claimed", name: "00504-行" });
    });

    it("answers 400 on open when the prerequisites are missing", async () => {
        const local = db.insertPost({ status: "draft", title: "未上线" });
        const res = await app.inject({ method: "POST", url: "/api/fileserve-dir/open", payload: { localId: local } });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain("先推送发布");
    });
});

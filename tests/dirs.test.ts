import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { stagingDirName, stagingNameMatches } from "../shared/staging-name.js";

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
    const name = (postId: number, parts: { title: string; slug: string | null; suffix: string }) =>
        stagingDirName(postId, parts as never);

    it("pads the id to 6 digits, sanitizes illegal characters and keeps CJK", () => {
        expect(name(501, { title: 'A/B:C*D?"E<F>G|H', slug: null, suffix: "title" })).toBe("000501-A B C D E F G H");
        expect(name(501, { title: "测试 文章", slug: null, suffix: "title" })).toBe("000501-测试 文章");
        expect(name(7, { title: "标题", slug: null, suffix: "title" })).toBe("000007-标题");
        // Ids beyond six digits are not truncated.
        expect(name(1234567, { title: "标题", slug: null, suffix: "title" }).startsWith("1234567-")).toBe(true);
    });

    it("builds the suffix per mode: slug, title and bare id", () => {
        expect(name(502, { title: "标题", slug: "502-abc", suffix: "slug" })).toBe("000502-502-abc");
        // A slugless row falls back to the title.
        expect(name(502, { title: "标题", slug: null, suffix: "slug" })).toBe("000502-标题");
        expect(name(502, { title: "标题", slug: "502-abc", suffix: "title" })).toBe("000502-标题");
        expect(name(502, { title: "标题", slug: "502-abc", suffix: "none" })).toBe("000502");
    });

    it("truncates the title to the budget at code points", () => {
        const long = name(12345, { title: "长".repeat(200), slug: null, suffix: "title" });
        // 80 budget - 6 (id) - 1 (dash) = 73 title code points.
        expect(Array.from(long)).toHaveLength(80);
        expect(long.startsWith("012345-")).toBe(true);
    });

    it("strips trailing dots and spaces, and falls back on an empty title", () => {
        expect(name(7, { title: "标题...", slug: null, suffix: "title" })).toBe("000007-标题");
        expect(name(7, { title: "   ", slug: null, suffix: "title" })).toBe("000007-untitled");
    });

    it("matches folders by the exact padded id only", () => {
        expect(stagingNameMatches("000502-renamed", 502)).toBe(true);
        expect(stagingNameMatches("000502", 502)).toBe(true);
        // The legacy 5-digit shape and longer ids never match.
        expect(stagingNameMatches("502-renamed", 502)).toBe(false);
        expect(stagingNameMatches("005025-similar", 502)).toBe(false);
    });
});

describe("staging dir ensure", () => {
    it("creates the padded folder on first call and claims it on every later one", async () => {
        const localId = db.insertPost({ status: "publish", title: "测试 文章", postId: 501 });

        const res = await app.inject({ method: "POST", url: "/api/fileserve-dir/ensure", payload: { localId } });
        const body = res.json();
        expect(body.status).toBe("created");
        expect(body.name).toBe("000501-测试 文章");
        expect(existsSync(join(workRoot, "000501-测试 文章"))).toBe(true);

        const again = await app.inject({ method: "POST", url: "/api/fileserve-dir/ensure", payload: { localId } });
        expect(again.json().status).toBe("claimed");
        expect(again.json().name).toBe("000501-测试 文章");

        // The lookup endpoint reads the filesystem, nothing else.
        const info = await app.inject({ method: "GET", url: `/api/fileserve-dir/${localId}` });
        expect(info.json().name).toBe("000501-测试 文章");
    });

    it("claims only the exact padded id; longer ids and other shapes never match", async () => {
        const localId = db.insertPost({ status: "publish", title: "测试 文章", postId: 502 });
        mkdirSync(join(workRoot, "000502-renamed-by-hand"));
        // A longer id sharing the digits must not be claimed, and the legacy
        // unpadded shape is not recognized either — the padded form is the
        // only name this feature has ever had.
        mkdirSync(join(workRoot, "5025-similar"));
        mkdirSync(join(workRoot, "502-legacy"));

        const res = await app.inject({ method: "POST", url: "/api/fileserve-dir/ensure", payload: { localId } });
        const body = res.json();
        expect(body.status).toBe("claimed");
        expect(body.name).toBe("000502-renamed-by-hand");
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
        expect(res2.json().reason).toContain("本地目录创建根");
        expect(existsSync(join(workRoot, "000503-行"))).toBe(false);
    });

    it("records nothing: deleting the row leaves the folder and no trace in the db", async () => {
        const localId = db.insertPost({ status: "publish", title: "行", postId: 504 });
        await app.inject({ method: "POST", url: "/api/fileserve-dir/ensure", payload: { localId } });
        await app.inject({ method: "DELETE", url: `/api/posts/${localId}` });
        expect(existsSync(join(workRoot, "000504-行"))).toBe(true);
        // The staging dirs are not modelled in SQL at all — no table to hold
        // them means nothing can go stale.
        const tables = (db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
            (entry) => entry.name,
        );
        expect(tables).not.toContain("fileserve_dirs");

        // A future row for the same post id claims the folder by prefix.
        const again = db.insertPost({ status: "publish", title: "行", postId: 504 });
        const res = await app.inject({ method: "POST", url: "/api/fileserve-dir/ensure", payload: { localId: again } });
        expect(res.json()).toMatchObject({ status: "claimed", name: "000504-行" });
    });

    it("answers 400 on open when the prerequisites are missing", async () => {
        const local = db.insertPost({ status: "draft", title: "未上线" });
        const res = await app.inject({ method: "POST", url: "/api/fileserve-dir/open", payload: { localId: local } });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain("先推送发布");
    });
});

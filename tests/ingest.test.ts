import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildIngestRows, INGEST_MAX_ROWS, type IngestBuildOptions } from "../shared/ingest.js";

// The db module opens its file at import time — point it at a temp dir before
// the app (and everything it pulls in) is imported.
process.env.PUBLISHER_DATA = mkdtempSync(join(tmpdir(), "publisher-ingest-"));

const OPTIONS: IngestBuildOptions = {
    authors: [
        { id: 2, name: "Yeraph" },
        { id: 7, name: "投稿员" },
    ],
    termOptions: {
        resource_category: [
            { id: 504, name: "漫画", slug: "comic" },
            { id: 605, name: "GALGAME", slug: "galgame" },
        ],
        resource_content: [{ id: 447, name: "恋爱", slug: "romance" }],
    },
    defaultStatus: "draft",
    defaultAuthorId: 2,
};

describe("buildIngestRows", () => {
    it("builds a dirty row out of a structured payload", () => {
        const built = buildIngestRows(
            [
                {
                    title: "  [GALGAME] 测试作  ",
                    content: '<img src="https://site/aiya_upload_pics/a.webp" />\n\n简介',
                    terms: { resource_category: ["GALGAME", 504], resource_content: ["恋爱", "日常"] },
                    fileserve: {
                        "1": { adapter: "platform", netdisk: "baidu", title: "百度网盘", price: 2, url: "", code: "" },
                    },
                },
            ],
            OPTIONS,
        );

        expect(built.fatal).toBeNull();
        expect(built.errors).toEqual([]);
        expect(built.rows).toEqual([
            {
                status: "draft",
                title: "[GALGAME] 测试作",
                content: '<img src="https://site/aiya_upload_pics/a.webp" />\n\n简介',
                authorId: 2,
                dateLocal: "",
                termRefs: {
                    // A known name folds to its id; an unknown one becomes a
                    // term the site creates on push, deduped case-insensitively
                    // against the id that is already there.
                    resource_category: ["605", "504"],
                    resource_content: ["447", "name:日常"],
                },
                fileserve: JSON.stringify({
                    "1": { url: "", code: "", title: "百度网盘", price: 2, adapter: "platform", netdisk: "baidu" },
                }),
            },
        ]);
    });

    it("collects every problem of a row into one error, the way CSV import does", () => {
        const built = buildIngestRows(
            [{ title: "", status: "撤回", dateLocal: "下周二", authorId: "路西法", terms: { nope: ["x"] } }],
            OPTIONS,
        );
        expect(built.rows).toEqual([]);
        expect(built.errors).toEqual([
            {
                row: 1,
                title: "（第 1 行）",
                error: "标题为空；状态无法识别：撤回；发布时间无法解读：下周二；作者未匹配：路西法；未知词法：nope",
            },
        ]);
    });

    it("never invents a term id, but accepts an unknown name as a to-create ref", () => {
        const built = buildIngestRows(
            [
                { title: "甲", terms: { resource_category: [999] } },
                { title: "乙", terms: { resource_category: [] } },
                { title: "丙", terms: { resource_category: "漫画" } },
            ],
            OPTIONS,
        );
        expect(built.errors).toEqual([
            { row: 1, title: "甲", error: "分类里没有 id 999 的术语" },
            { row: 3, title: "丙", error: "分类的术语必须是数组。" },
        ]);
        expect(built.rows).toHaveLength(1);
        expect(built.rows[0]?.termRefs).toEqual({});
    });

    it("carries a date, a status and an author by name", () => {
        const built = buildIngestRows(
            [
                { title: "定时甲", status: "future", dateLocal: "2026/10/6 8:00", authorId: "投稿员" },
                { title: "定时乙", status: "定时" },
                { title: "普通丙", authorId: 7, dateLocal: "2026-10-05T09:30" },
            ],
            OPTIONS,
        );
        expect(built.errors).toEqual([
            { row: 2, title: "定时乙", error: "定时（future）行必须携带发布时间" },
        ]);
        expect(built.rows[0]).toMatchObject({ status: "future", dateLocal: "2026-10-06T08:00", authorId: 7 });
        expect(built.rows[1]).toMatchObject({ status: "draft", dateLocal: "2026-10-05T09:30", authorId: 7 });
    });

    it("normalizes the file list and treats an empty one as no file list", () => {
        const built = buildIngestRows(
            [
                { title: "空组", fileserve: {} },
                { title: "坏适配器", fileserve: { "1": { adapter: "nope" } } },
                { title: "数组", fileserve: [] },
                { title: "字符串", fileserve: '{"1":{"adapter":"platform"}}' },
            ],
            OPTIONS,
        );
        expect(built.rows[0]?.fileserve).toBeNull();
        expect(built.errors.map((error) => error.title)).toEqual(["坏适配器", "数组", "字符串"]);
        expect(built.errors[0]?.error).toContain("适配器不可用");
        expect(built.errors[1]?.error).toContain("必须是「组 id → 组字段」的对象");
        expect(built.errors[2]?.error).toContain("必须是「组 id → 组字段」的对象");
    });

    it("refuses a payload with no rows, a non-array, or past the cap", () => {
        expect(buildIngestRows(undefined, OPTIONS).fatal).toBe("请求里没有 rows 数组。");
        expect(buildIngestRows({}, OPTIONS).fatal).toBe("请求里没有 rows 数组。");
        expect(buildIngestRows([], OPTIONS).fatal).toBe("没有可摄取的行。");
        const many = Array.from({ length: INGEST_MAX_ROWS + 1 }, (_, index) => ({ title: `t${index}` }));
        expect(buildIngestRows(many, OPTIONS).fatal).toContain(String(INGEST_MAX_ROWS));
        expect(buildIngestRows(many, OPTIONS).rows).toEqual([]);
    });
});

let app: FastifyInstance;
let db: typeof import("../server/db.js");

beforeAll(async () => {
    db = await import("../server/db.js");
    db.setSetting("defaultAuthorId", "2");
    db.setSetting("siteUrl", "http://localhost:8000");
    db.upsertAuthor(2, "Yeraph");
    db.replaceTerms([
        {
            slug: "resource_category",
            hierarchical: true,
            terms: [
                { id: 504, name: "漫画", slug: "comic", count: 167 },
                { id: 605, name: "GALGAME", slug: "galgame", count: 137 },
            ],
        },
        {
            slug: "resource_content",
            hierarchical: false,
            terms: [{ id: 447, name: "恋爱", slug: "romance", count: 62 }],
        },
    ]);
    const { buildApp } = await import("../server/index.js");
    // The vocabulary's ranking is local usage (the synced mirror of the site),
    // so seed it: two rows carry 漫画, one carries GALGAME.
    const synced = { status: "publish", content: "", authorId: 2, dateLocal: "", dirty: false, lastSyncedGmt: null };
    const first = db.insertPost({ ...synced, title: "已同步甲" });
    const second = db.insertPost({ ...synced, title: "已同步乙" });
    const third = db.insertPost({ ...synced, title: "已同步丙" });
    db.setTermRefs(first, { resource_category: ["504"] });
    db.setTermRefs(second, { resource_category: ["504"] });
    db.setTermRefs(third, { resource_category: ["605"] });

    app = await buildApp();
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

describe("ingest endpoints", () => {
    it("hands a client the vocabulary, ranked by how much the site uses it", async () => {
        const res = await app.inject({ method: "GET", url: "/api/ingest/context" });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.siteUrl).toBe("http://localhost:8000");
        expect(body.defaultStatus).toBe("draft");
        expect(body.ingestMaxRows).toBe(INGEST_MAX_ROWS);
        expect(body.netdiskOptions.map((option: { id: string }) => option.id)).toEqual(["baidu", "quark"]);
        // The proxy rides along so the intake window can show where the model
        // call goes; the setting is empty here, which reads as direct.
        expect(body.proxyUrl).toBe("");
        expect(body.netdiskTodo).toEqual({ enabled: false, groups: [] });
        expect(body.terms.resource_category).toEqual([
            { id: 504, name: "漫画", slug: "comic", parent: 0, count: 2, path: "漫画" },
            { id: 605, name: "GALGAME", slug: "galgame", parent: 0, count: 1, path: "GALGAME" },
        ]);
    });

    it("accepts a request from the intake window's own origin and rejects other sites", async () => {
        // The isolated intake process serves its page from 127.0.0.1:5180 and
        // calls this endpoint from the browser: a different port, same host.
        const window = await app.inject({
            method: "GET",
            url: "/api/ingest/context",
            headers: { origin: "http://127.0.0.1:5180" },
        });
        expect(window.statusCode).toBe(200);

        const foreign = await app.inject({
            method: "GET",
            url: "/api/ingest/context",
            headers: { origin: "https://evil.example" },
        });
        expect(foreign.statusCode).toBe(403);
    });

    it("previews the rows it would write without writing them", async () => {
        const before = await app.inject({ method: "GET", url: "/api/state" });

        const res = await app.inject({
            method: "POST",
            url: "/api/ingest/preview",
            payload: {
                rows: [
                    { title: "预览甲", terms: { resource_category: ["漫画"] } },
                    { title: "", status: "撤回" },
                ],
            },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.count).toBe(1);
        expect(body.rows[0]).toMatchObject({ title: "预览甲", status: "draft", authorId: 2 });
        expect(body.rows[0].terms).toEqual({ resource_category: ["504"] });
        expect(body.errors).toHaveLength(1);

        const after = await app.inject({ method: "GET", url: "/api/state" });
        expect(after.json().posts.length).toBe(before.json().posts.length);
    });

    it("writes good rows dirty into the queue, reports the bad ones, and logs it", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/api/ingest",
            payload: {
                source: "intake",
                rows: [
                    {
                        title: "摄取甲",
                        content: '<img src="https://site/aiya_upload_pics/x.webp" />',
                        terms: { resource_category: ["漫画", "新标签"] },
                        fileserve: { "1": { adapter: "platform", netdisk: "baidu", title: "百度网盘", price: 2 } },
                    },
                    { title: "摄取乙", status: "future" },
                ],
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().imported).toBe(1);
        expect(res.json().localIds).toHaveLength(1);
        expect(res.json().errors).toEqual([
            { row: 2, title: "摄取乙", error: "定时（future）行必须携带发布时间" },
        ]);

        const state = await app.inject({ method: "GET", url: "/api/state" });
        const row = state.json().posts.find((post: { title: string }) => post.title === "摄取甲");
        expect(row.dirty).toBe(true);
        expect(row.postId).toBeNull();
        expect(row.status).toBe("draft");
        expect(row.authorId).toBe(2);
        expect(row.content).toContain("aiya_upload_pics/x.webp");
        // Byte order through the (local_id, taxonomy, ref) index — compare as sets.
        expect(row.terms.resource_category).toHaveLength(2);
        expect(row.terms.resource_category).toEqual(expect.arrayContaining(["504", "name:新标签"]));
        // The netdisk field is a local-only extension: it must survive ingest,
        // because it is what the netdisk lane claims the group by.
        expect(row.fileserveParsed["1"]).toMatchObject({ adapter: "platform", netdisk: "baidu", price: 2 });

        const logs = db.listLogs(0, 100);
        const messages = logs.map((entry) => entry.message);
        expect(logs.some((entry) => entry.scope === "摄取")).toBe(true);
        expect(messages.some((message) => message.includes("来源 intake"))).toBe(true);
    });

    it("answers 400 with the payload-level reason and writes nothing", async () => {
        const empty = await app.inject({ method: "POST", url: "/api/ingest", payload: { rows: [] } });
        expect(empty.statusCode).toBe(400);
        expect(empty.json().error).toBe("没有可摄取的行。");

        const missing = await app.inject({ method: "POST", url: "/api/ingest/preview", payload: {} });
        expect(missing.statusCode).toBe(400);
        expect(missing.json().error).toBe("请求里没有 rows 数组。");

        const many = await app.inject({
            method: "POST",
            url: "/api/ingest",
            payload: { rows: Array.from({ length: INGEST_MAX_ROWS + 1 }, (_, index) => ({ title: `t${index}` })) },
        });
        expect(many.statusCode).toBe(400);
        expect(many.json().error).toContain(String(INGEST_MAX_ROWS));
    });

    // Runs last on purpose: it replaces the term registry and switches the
    // netdisk work-order setting on, which the cases above must not see.
    it("publishes the taxonomy tree as paths and the 挂网盘待办组 setting as groups", async () => {
        db.replaceTerms([
            {
                slug: "resource_category",
                hierarchical: true,
                terms: [
                    { id: 53, name: "原作", slug: "root", parent: 0, count: 0 },
                    { id: 54, name: "系列", slug: "child", parent: 53, count: 0 },
                ],
            },
        ]);
        await app.inject({
            method: "PUT",
            url: "/api/settings",
            payload: { proxyUrl: "http://127.0.0.1:10808", netdiskTodoEnabled: true, netdiskTodoGroups: "baidu,quark" },
        });

        const res = await app.inject({ method: "GET", url: "/api/ingest/context" });
        const body = res.json();
        expect(body.proxyUrl).toBe("http://127.0.0.1:10808");
        expect(body.netdiskTodo).toEqual({
            enabled: true,
            groups: [
                { id: "baidu", label: "百度网盘" },
                { id: "quark", label: "夸克网盘" },
            ],
        });
        // Both are unused (count 0), so the tie-break is the zh name order:
        // 系列 first. The child's path still starts at its parent.
        expect(body.terms.resource_category).toEqual([
            { id: 54, name: "系列", slug: "child", parent: 53, count: 0, path: "原作 / 系列" },
            { id: 53, name: "原作", slug: "root", parent: 0, count: 0, path: "原作" },
        ]);
    });

    it("folds a same-named term to the most used one and says which it picked", async () => {
        // WP allows 子X under two parents. The vocabulary is usage-ordered, so
        // the name folds deterministically — but the caller has to be told,
        // because by name alone the two are indistinguishable.
        db.replaceTerms([
            {
                slug: "resource_category",
                hierarchical: true,
                terms: [
                    { id: 61, name: "原作A", slug: "root-a", parent: 0, count: 0 },
                    { id: 62, name: "子X", slug: "child-a", parent: 61, count: 0 },
                    { id: 63, name: "子X", slug: "child-b", parent: 0, count: 0 },
                ],
            },
        ]);
        const used = db.insertPost({
            status: "publish",
            title: "用过 63",
            content: "",
            authorId: 2,
            dateLocal: "",
            dirty: false,
            lastSyncedGmt: null,
        });
        db.setTermRefs(used, { resource_category: ["63"] });

        const res = await app.inject({
            method: "POST",
            url: "/api/ingest/preview",
            payload: { rows: [{ title: "同名折叠", terms: { resource_category: ["子X"] } }] },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().rows[0].terms).toEqual({ resource_category: ["63"] });
        expect(res.json().warnings).toEqual([
            { row: 1, title: "同名折叠", warning: "分类「子X」有 2 个同名术语，已取使用最多的 #63" },
        ]);
    });

    it("挂网盘待办组 attaches the empty-link work orders to a fresh ingested row", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/api/ingest",
            payload: { source: "intake", rows: [{ title: "待办组甲" }, { title: "自带文件", fileserve: null }] },
        });
        expect(res.statusCode).toBe(200);
        const state = await app.inject({ method: "GET", url: "/api/state" });
        const withTodo = state.json().posts.find((post: { title: string }) => post.title === "待办组甲");
        expect(withTodo.fileserveParsed["1"]).toMatchObject({ adapter: "platform", netdisk: "baidu", title: "百度网盘", price: 2 });
        expect(withTodo.fileserveParsed["2"]).toMatchObject({ adapter: "platform", netdisk: "quark", title: "夸克网盘", price: 2 });
        // An explicit `fileserve: null` is the payload saying "none".
        const explicit = state.json().posts.find((post: { title: string }) => post.title === "自带文件");
        expect(explicit.fileserveParsed).toBeNull();
    });
});
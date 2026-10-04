import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { configDigest } from "../server/digest.js";
import { WpError, type WpItem } from "../server/wp.js";

// The db module opens its file at import time — point it at a temp dir
// before the app (and everything it pulls in) is imported.
process.env.PUBLISHER_DATA = mkdtempSync(join(tmpdir(), "publisher-completion-"));

// The site calls are scripted; the rest of the client stays real. The
// whole-row push is driven through createResource/updateResource for the
// mutual-exclusion and baseline tests.
vi.mock("../server/wp.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../server/wp.js")>();
    return {
        ...actual,
        updateResourceFileserve: vi.fn(),
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

/** A one-group platform config — what a completion push sends and what the
 * site echoes back once its normalizer has had it. */
const platformConfig = (url: string): WpItem["fileserve"] => ({
    "1": { adapter: "platform", url, code: "a1b2", title: "百度网盘", price: 0 },
});

beforeAll(async () => {
    ({ buildApp } = await import("../server/index.js"));
    app = await buildApp();
    await app.ready();
    wp = await import("../server/wp.js");
    db = await import("../server/db.js");
    db.setSetting("siteUrl", "http://completion.test");
    db.setSetting("username", "u");
    db.setSetting("appPassword", "p");
});

afterAll(async () => {
    await app.close();
});

beforeEach(() => {
    vi.mocked(wp.updateResourceFileserve).mockReset();
    vi.mocked(wp.createResource).mockReset();
    vi.mocked(wp.updateResource).mockReset();
    db.db.exec("DELETE FROM posts");
});

describe("completion push", () => {
    it("writes the row's file list only and scopes the write-back on a dirty row", async () => {
        const localId = db.insertPost({
            status: "publish",
            title: "原标题",
            content: "正文",
            postId: 501,
            fileserve: JSON.stringify(platformConfig("https://pan.baidu.com/s/1abc")),
            dateLocal: "2026-01-01T08:00:00",
            dateGmt: "2026-01-01T00:00:00",
            modifiedGmt: "2026-01-01T00:00:00",
            dirty: true,
            snapshot: JSON.stringify({
                status: "publish",
                title: "原标题",
                content: "正文",
                authorId: null,
                dateLocal: "2026-01-01T08:00:00",
                dateGmt: "2026-01-01T00:00:00",
                modifiedGmt: "2026-01-01T00:00:00",
                terms: {},
                fileserve: null,
            }),
        });
        db.updatePostRow(localId, { title: "本地改过的标题" });

        const pushedFileserve = platformConfig("https://pan.baidu.com/s/1abc");
        vi.mocked(wp.updateResourceFileserve).mockResolvedValue(
            item(501, {
                fileserve: pushedFileserve,
                date: "2026-10-04T12:00:00",
                dateGmt: "2026-10-04T04:00:00",
                modifiedGmt: "2026-10-04T04:00:00",
            }),
        );

        const res = await app.inject({ method: "POST", url: "/api/completion/push", payload: {} });
        const body = res.json();
        expect(body.ok).toBe(true);
        expect(body.pushed).toBe(1);

        // The site call carried exactly the row's file list — nothing else.
        expect(wp.updateResourceFileserve).toHaveBeenCalledTimes(1);
        const [, calledPostId, calledConfig] = vi.mocked(wp.updateResourceFileserve).mock.calls[0]!;
        expect(calledPostId).toBe(501);
        expect(calledConfig).toEqual(pushedFileserve);

        // Scoped write-back: fileserve + stamps move, the in-flight edits and
        // the dirty flag do not.
        const after = db.getPost(localId)!;
        expect(after.title).toBe("本地改过的标题");
        expect(after.dirty).toBe(true);
        expect(after.dateLocal).toBe("2026-01-01T08:00:00");
        expect(after.modifiedGmt).toBe("2026-10-04T04:00:00");
        expect(JSON.parse(after.fileserve!)).toEqual(pushedFileserve);
        // The digest baseline rides on the server-confirmed shape.
        expect(after.fileservePushedDigest).toBe(configDigest(pushedFileserve));
        const snapshot = JSON.parse(after.snapshot!);
        expect(snapshot.fileserve).toEqual(pushedFileserve);
        expect(snapshot.modifiedGmt).toBe("2026-10-04T04:00:00");

        // A second run finds nothing new.
        const again = await app.inject({ method: "POST", url: "/api/completion/push", payload: {} });
        expect(again.json().pushed).toBe(0);
        expect(wp.updateResourceFileserve).toHaveBeenCalledTimes(1);
    });

    it("refuses rows whose groups miss their required field, naming the group", async () => {
        const localId = db.insertPost({
            status: "publish",
            title: "行",
            postId: 502,
            fileserve: JSON.stringify({ "1": { adapter: "platform", url: "", code: "", title: "百度网盘", price: 0 } }),
        });

        const res = await app.inject({ method: "POST", url: "/api/completion/push", payload: { localIds: [localId] } });
        const body = res.json();
        expect(body.pushed).toBe(0);
        expect(body.failed).toBe(1);
        expect(body.errors[0].message).toContain("组 #1");
        expect(body.errors[0].message).toContain("链接");
        expect(wp.updateResourceFileserve).not.toHaveBeenCalled();
        expect(db.getPost(localId)?.lastError).toContain("组 #1");
    });

    it("ignores rows without a post, without a list, and lists the site already confirmed", async () => {
        db.insertPost({ status: "publish", title: "未上线", fileserve: JSON.stringify(platformConfig("https://x")) });
        db.insertPost({ status: "publish", title: "空列表", postId: 503, fileserve: "{}" });
        const confirmed = db.insertPost({
            status: "publish",
            title: "已推送",
            postId: 504,
            fileserve: JSON.stringify(platformConfig("https://y")),
        });
        db.updatePostRow(confirmed, { fileservePushedDigest: configDigest(platformConfig("https://y")) });

        const res = await app.inject({ method: "POST", url: "/api/completion/push", payload: {} });
        expect(res.json()).toMatchObject({ ok: true, pushed: 0, failed: 0 });
        expect(wp.updateResourceFileserve).not.toHaveBeenCalled();
    });

    it("aborts after three consecutive transport failures", async () => {
        for (let i = 0; i < 4; i += 1) {
            db.insertPost({
                status: "publish",
                title: `行${i}`,
                postId: 600 + i,
                fileserve: JSON.stringify(platformConfig("https://pan.baidu.com/s/x")),
            });
        }
        vi.mocked(wp.updateResourceFileserve).mockRejectedValue(new WpError(0, "aiya_publish_unreachable", "无法连接站点"));

        const res = await app.inject({ method: "POST", url: "/api/completion/push", payload: {} });
        const body = res.json();
        expect(body.pushed).toBe(0);
        expect(body.failed).toBe(3);
        expect(body.error).toContain("已中止本轮补完推送");
        expect(body.error).toContain("剩余 1 行");
        expect(wp.updateResourceFileserve).toHaveBeenCalledTimes(3);
    });

    it("answers 409 while a whole-row push holds the slot", async () => {
        db.insertPost({ status: "draft", title: "普通行", dirty: true });
        let release!: (value: WpItem) => void;
        const gate = new Promise<WpItem>((resolve) => {
            release = resolve;
        });
        vi.mocked(wp.createResource).mockReturnValue(gate);

        const first = app.inject({ method: "POST", url: "/api/push", payload: {} });
        await new Promise((resolve) => setTimeout(resolve, 25));

        const completion = await app.inject({ method: "POST", url: "/api/completion/push", payload: {} });
        expect(completion.statusCode).toBe(409);
        expect(completion.json().error).toContain("已有推送在进行中");

        release(item(201));
        expect((await first).json().pushed).toBe(1);
    });

    it("a whole-row push re-confirms the baseline, so completion finds nothing new", async () => {
        const localId = db.insertPost({
            status: "publish",
            title: "行",
            postId: 505,
            fileserve: JSON.stringify(platformConfig("https://pan.baidu.com/s/z")),
            dirty: true,
        });
        vi.mocked(wp.updateResource).mockResolvedValue(item(505, { fileserve: platformConfig("https://pan.baidu.com/s/z") }));

        const res = await app.inject({ method: "POST", url: "/api/push", payload: {} });
        expect(res.json().pushed).toBe(1);

        const after = db.getPost(localId)!;
        expect(after.fileservePushedDigest).toBe(configDigest(platformConfig("https://pan.baidu.com/s/z")));

        const again = await app.inject({ method: "POST", url: "/api/completion/push", payload: {} });
        expect(again.json().pushed).toBe(0);
        expect(wp.updateResourceFileserve).not.toHaveBeenCalled();
    });
});

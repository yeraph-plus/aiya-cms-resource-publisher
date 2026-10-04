import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { WpError, type WpItem } from "../server/wp.js";

// The db module opens its file at import time — point it at a temp dir
// before the app (and everything it pulls in) is imported.
process.env.PUBLISHER_DATA = mkdtempSync(join(tmpdir(), "publisher-completion-"));

// Only the two site calls the completion flow makes are scripted; the rest
// of the client stays real. The whole-row push is driven through
// createResource below for the mutual-exclusion test.
vi.mock("../server/wp.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../server/wp.js")>();
    return {
        ...actual,
        getResource: vi.fn(),
        updateResourceFileserve: vi.fn(),
        createResource: vi.fn(),
    };
});

let app: FastifyInstance;
let buildApp: typeof import("../server/index.js").buildApp;
let wp: typeof import("../server/wp.js");
let db: typeof import("../server/db.js");
let workRoot: string;

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

const carrierPath = (dirName: string): string => join(workRoot, dirName, "fileserve.json");

/** Simulates the share step: links land in the carrier JSON, nothing else. */
const fillShare = (dirName: string, url: string, code: string): void => {
    const carrier = JSON.parse(readFileSync(carrierPath(dirName), "utf8"));
    carrier.groups[0].url = url;
    carrier.groups[0].code = code;
    carrier.groups[0].sharedAt = "2026-10-04T00:00:00Z";
    writeFileSync(carrierPath(dirName), JSON.stringify(carrier, null, 4));
};

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
    vi.mocked(wp.getResource).mockReset();
    vi.mocked(wp.updateResourceFileserve).mockReset();
    vi.mocked(wp.createResource).mockReset();
    db.db.exec("DELETE FROM posts");
    workRoot = mkdtempSync(join(tmpdir(), "publisher-workroot-"));
    db.setSetting("workRoot", workRoot);
    db.setSetting("dirNameMode", "id");
});

describe("skeleton generation", () => {
    it("creates the sink and backfills the slug from the site", async () => {
        const localId = db.insertPost({ status: "publish", title: "行", postId: 501 });
        vi.mocked(wp.getResource).mockResolvedValue(item(501, { link: "https://x.test/resource/501-abc/" }));

        const res = await app.inject({ method: "POST", url: "/api/fileserve-sink/generate", payload: { localId } });
        expect(res.statusCode).toBe(200);
        expect(res.json().dirName).toBe("501");

        expect(db.getPost(localId)?.slug).toBe("501-abc");
        const scan = await app.inject({ method: "GET", url: `/api/fileserve-sink/scan?localId=${localId}` });
        const sink = scan.json().sinks[0];
        expect(sink.status).toBe("draft");
        expect(sink.carrier.localId).toBe(localId);
        expect(sink.carrier.postId).toBe(501);
        expect(sink.carrier.groups).toHaveLength(2);
    });

    it("refuses rows without a post or with an existing file list", async () => {
        const new_row = db.insertPost({ status: "draft", title: "未推送" });
        const res = await app.inject({ method: "POST", url: "/api/fileserve-sink/generate", payload: { localId: new_row } });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain("先推送发布");

        const configured = db.insertPost({
            status: "publish",
            title: "已配置",
            postId: 502,
            fileserve: '{"1":{"adapter":"platform","url":"https://x"}}',
        });
        const res2 = await app.inject({ method: "POST", url: "/api/fileserve-sink/generate", payload: { localId: configured } });
        expect(res2.statusCode).toBe(400);
        expect(res2.json().error).toContain("已有文件列表");
    });
});

describe("completion push", () => {
    it("writes only the file list and scopes the write-back on a dirty row", async () => {
        const localId = db.insertPost({
            status: "publish",
            title: "原标题",
            content: "正文",
            postId: 501,
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

        await app.inject({ method: "POST", url: "/api/fileserve-sink/generate", payload: { localId } });
        fillShare("501", "https://pan.baidu.com/s/1abc", "a1b2");

        const pushedFileserve = { "1": { adapter: "platform", url: "https://pan.baidu.com/s/1abc", code: "a1b2", title: "百度网盘", price: 0 } };
        vi.mocked(wp.updateResourceFileserve).mockResolvedValue(
            item(501, {
                fileserve: pushedFileserve,
                date: "2026-10-04T12:00:00",
                dateGmt: "2026-10-04T04:00:00",
                modifiedGmt: "2026-10-04T04:00:00",
            }),
        );

        const res = await app.inject({ method: "POST", url: "/api/fileserve-sink/push", payload: {} });
        const body = res.json();
        expect(body.ok).toBe(true);
        expect(body.pushed).toBe(1);

        // The site call carried exactly the compiled config — nothing else.
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
        const snapshot = JSON.parse(after.snapshot!);
        expect(snapshot.fileserve).toEqual(pushedFileserve);
        expect(snapshot.modifiedGmt).toBe("2026-10-04T04:00:00");

        // The carrier is marked pushed; a second push finds nothing new.
        const carrier = JSON.parse(readFileSync(carrierPath("501"), "utf8"));
        expect(carrier.status).toBe("pushed");
        expect(carrier.pushedDigest).toBeTruthy();

        const again = await app.inject({ method: "POST", url: "/api/fileserve-sink/push", payload: {} });
        expect(again.json().pushed).toBe(0);
        expect(wp.updateResourceFileserve).toHaveBeenCalledTimes(1);
    });

    it("skips carriers whose groups have no links at all", async () => {
        const localId = db.insertPost({ status: "publish", title: "行", postId: 503 });
        await app.inject({ method: "POST", url: "/api/fileserve-sink/generate", payload: { localId } });

        const res = await app.inject({ method: "POST", url: "/api/fileserve-sink/push", payload: {} });
        expect(res.json().pushed).toBe(0);
        expect(wp.updateResourceFileserve).not.toHaveBeenCalled();
    });

    it("aborts after three consecutive transport failures", async () => {
        for (let i = 0; i < 4; i += 1) {
            const localId = db.insertPost({ status: "publish", title: `行${i}`, postId: 600 + i });
            await app.inject({ method: "POST", url: "/api/fileserve-sink/generate", payload: { localId } });
            fillShare(String(600 + i), "https://pan.baidu.com/s/x", "code");
        }
        vi.mocked(wp.updateResourceFileserve).mockRejectedValue(new WpError(0, "aiya_publish_unreachable", "无法连接站点"));

        const res = await app.inject({ method: "POST", url: "/api/fileserve-sink/push", payload: {} });
        const body = res.json();
        expect(body.pushed).toBe(0);
        expect(body.failed).toBe(3);
        expect(body.error).toContain("已中止本轮补完推送");
        expect(body.error).toContain("剩余 1 个骨架");
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

        const completion = await app.inject({ method: "POST", url: "/api/fileserve-sink/push", payload: {} });
        expect(completion.statusCode).toBe(409);
        expect(completion.json().error).toContain("已有推送在进行中");

        release(item(201));
        expect((await first).json().pushed).toBe(1);
    });
});

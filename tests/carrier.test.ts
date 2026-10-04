import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    buildCarrier,
    carrierDigest,
    carrierStatus,
    compileConfig,
    dirNameFor,
    generateSink,
    listSinks,
    markCarrierPushed,
    parseTemplate,
    slugSafe,
    type CarrierFile,
} from "../server/carrier.js";
import { parseSlugFromLink } from "../server/wp.js";
import type { PostRow } from "../server/db.js";

function row(patch: Partial<PostRow> = {}): PostRow {
    return {
        localId: 7,
        postId: 501,
        status: "publish",
        title: "标题",
        content: "",
        authorId: null,
        dateLocal: "",
        dateGmt: "",
        modifiedGmt: "",
        fileserve: null,
        slug: null,
        dirty: false,
        conflict: false,
        missing: false,
        lastSyncedGmt: null,
        lastPushedGmt: null,
        lastError: null,
        snapshot: null,
        ...patch,
    };
}

describe("parseSlugFromLink", () => {
    it("takes the last path segment", () => {
        expect(parseSlugFromLink("https://x.test/resource/501-abc/")).toBe("501-abc");
        expect(parseSlugFromLink("https://x.test/resource/501")).toBe("501");
    });

    it("answers null for plain permalinks and broken links", () => {
        expect(parseSlugFromLink("https://x.test/?p=501")).toBeNull();
        expect(parseSlugFromLink("not a url")).toBeNull();
    });

    it("decodes percent-encoded slugs (the dir-name check rejects them later)", () => {
        expect(parseSlugFromLink("https://x.test/resource/%e6%96%87%e7%ab%a0")).toBe("文章");
    });
});

describe("dir naming", () => {
    it("treats only pure ASCII slugs as directory-safe", () => {
        expect(slugSafe("501-abc")).toBe(true);
        expect(slugSafe("some.title_v2")).toBe(true);
        expect(slugSafe("文章")).toBe(false);
        expect(slugSafe("501%e6%96%87")).toBe(false);
        expect(slugSafe("")).toBe(false);
        expect(slugSafe(null)).toBe(false);
    });

    it("builds the dir name per mode, falling back to the id on unsafe slugs", () => {
        expect(dirNameFor(501, "501-abc", "id")).toBe("501");
        expect(dirNameFor(501, "501-abc", "id-slug")).toBe("501-501-abc");
        expect(dirNameFor(501, "501-abc", "slug")).toBe("501-abc");
        expect(dirNameFor(501, "%e6%96%87%e7%ab%a0", "id-slug")).toBe("501");
        expect(dirNameFor(501, null, "slug")).toBe("501");
    });
});

describe("group template", () => {
    it("defaults to baidu + quark when unset", () => {
        const { template, error } = parseTemplate(null);
        expect(error).toBeNull();
        expect(template.map((entry) => entry.netdisk)).toEqual(["baidu", "quark"]);
    });

    it("rejects broken JSON and entries without a netdisk", () => {
        expect(parseTemplate("{").error).toContain("JSON");
        expect(parseTemplate("[]").error).toContain("非空数组");
        expect(parseTemplate('[{"title":"x"}]').error).toContain("netdisk");
    });

    it("fills the title from the netdisk and clamps the price", () => {
        const { template, error } = parseTemplate('[{"netdisk":"quark","price":-3}]');
        expect(error).toBeNull();
        expect(template).toEqual([{ netdisk: "quark", title: "quark", price: 0 }]);
    });
});

describe("carrier compile and status", () => {
    const carrier = (groups: Partial<CarrierFile["groups"][number]>[]): CarrierFile => ({
        version: 1,
        localId: 7,
        postId: 501,
        slug: null,
        dirName: "501",
        createdAt: "2026-10-04T00:00:00Z",
        pushedAt: null,
        pushedDigest: null,
        status: "draft",
        groups: groups.map((group, index) => ({
            id: String(index + 1),
            netdisk: "baidu",
            remoteDir: "501",
            title: "百度网盘",
            price: 0,
            url: null,
            code: null,
            sharedAt: null,
            ...group,
        })),
    });

    it("compiles only the groups that carry a share link", () => {
        const config = compileConfig(
            carrier([
                { url: " https://pan.baidu.com/s/1abc ", code: " a1 " },
                { url: null },
                { url: "" },
            ]),
        );
        expect(config).toEqual({
            "1": { adapter: "platform", url: "https://pan.baidu.com/s/1abc", code: "a1", title: "百度网盘", price: 0 },
        });
    });

    it("resolves a sanitized-id collision first-wins, like the domain", () => {
        const config = compileConfig(
            carrier([
                { id: "1", url: "https://pan.baidu.com/s/first" },
                { id: "1!", url: "https://pan.baidu.com/s/second" },
            ]),
        );
        expect(Object.keys(config)).toEqual(["1"]);
        expect(config["1"]).toMatchObject({ url: "https://pan.baidu.com/s/first" });
    });

    it("moves draft → ready → pushed, and back to ready when links change", () => {
        const empty = carrier([{}]);
        expect(carrierStatus(empty)).toBe("draft");

        const filled = carrier([{ url: "https://pan.baidu.com/s/1abc" }]);
        expect(carrierStatus(filled)).toBe("ready");

        const pushed = { ...filled, pushedDigest: carrierDigest(compileConfig(filled)) };
        expect(carrierStatus(pushed)).toBe("pushed");

        const grown = { ...pushed, groups: [...pushed.groups, { ...pushed.groups[0]!, id: "2", url: "https://pan.quark.cn/s/x" }] };
        expect(carrierStatus(grown)).toBe("ready");
    });

    it("digests differ when any field moves", () => {
        const a = compileConfig(carrier([{ url: "https://pan.baidu.com/s/1abc", price: 0 }]));
        const b = compileConfig(carrier([{ url: "https://pan.baidu.com/s/1abc", price: 1 }]));
        expect(carrierDigest(a)).not.toBe(carrierDigest(b));
        expect(carrierDigest(a)).toBe(carrierDigest(a));
    });
});

describe("sink files", () => {
    it("generates a skeleton directory + carrier, scans it, and marks it pushed", () => {
        const workRoot = mkdtempSync(join(tmpdir(), "publisher-sink-"));
        const result = generateSink(row({ postId: 501, slug: "501-abc" }), "501-abc", {
            workRoot,
            dirNameMode: "id-slug",
            template: [
                { netdisk: "baidu", title: "百度网盘", price: 2 },
                { netdisk: "quark", title: "夸克网盘", price: 0 },
            ],
        });
        expect(result.dirName).toBe("501-501-abc");
        expect(existsSync(join(workRoot, "501-501-abc", "fileserve.json"))).toBe(true);

        const sinks = listSinks(workRoot);
        expect(sinks).toHaveLength(1);
        expect(sinks[0]!.status).toBe("draft");
        expect(sinks[0]!.carrier?.groups.map((group) => group.id)).toEqual(["1", "2"]);
        expect(sinks[0]!.carrier?.groups.every((group) => group.remoteDir === "501-501-abc")).toBe(true);

        // Simulate the share step writing links back into the carrier.
        const carrier = JSON.parse(JSON.stringify(sinks[0]!.carrier));
        carrier.groups[0]!.url = "https://pan.baidu.com/s/1abc";
        carrier.groups[0]!.code = "a1b2";
        writeFileSync(result.path, JSON.stringify(carrier, null, 4));

        const ready = listSinks(workRoot);
        expect(ready[0]!.status).toBe("ready");

        const config = compileConfig(ready[0]!.carrier!);
        markCarrierPushed(result.path, ready[0]!.carrier!, config);
        expect(listSinks(workRoot)[0]!.status).toBe("pushed");
    });

    it("refuses rows without a post, with a file list, and duplicate generation", () => {
        const workRoot = mkdtempSync(join(tmpdir(), "publisher-sink-"));
        expect(() => generateSink(row({ postId: null }), null, { workRoot, dirNameMode: "id", template: [] })).toThrow("先推送发布");
        expect(() =>
            generateSink(row({ fileserve: '{"1":{"adapter":"platform","url":"https://x"}}' }), null, {
                workRoot,
                dirNameMode: "id",
                template: [],
            }),
        ).toThrow("已有文件列表");
        generateSink(row(), null, { workRoot, dirNameMode: "id", template: [] });
        expect(() => generateSink(row(), null, { workRoot, dirNameMode: "id", template: [] })).toThrow("已存在");
    });

    it("reports broken carriers instead of failing the sweep", () => {
        const workRoot = mkdtempSync(join(tmpdir(), "publisher-sink-"));
        generateSink(row(), null, { workRoot, dirNameMode: "id", template: [] });
        const path = join(workRoot, "501", "fileserve.json");
        writeFileSync(path, "{ not json");

        const sinks = listSinks(workRoot);
        expect(sinks[0]!.status).toBe("broken");
        expect(sinks[0]!.error).toContain("JSON");
        expect(sinks[0]!.carrier).toBeNull();
    });
});

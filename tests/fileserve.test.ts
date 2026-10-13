import { describe, expect, it } from "vitest";
import {
    ADAPTER_FIELDS,
    configSummary,
    emptyGroup,
    mergeFileserveDraft,
    mergeRemoteFileserve,
    nextId,
    normalizeConfig,
    priceDefault,
    productionConfig,
    sanitizeId,
} from "../shared/fileserve.js";

/**
 * The netdisk lane fills links from another window, so a detail panel can hold
 * a draft taken before that fill. The merge decides per group which side wins.
 */
describe("fileserve draft merge", () => {
    const group = (url: string, netdisk = "baidu") => ({ adapter: "platform", url, code: "", title: "百度网盘", price: 0, netdisk });
    const stored = (config: Record<string, unknown>) => JSON.stringify(config);

    it("lets the fill win over the stale draft's empty link", () => {
        const base = stored({ "1": group("") });
        const filled = { "1": group("https://pan.baidu.com/s/x?pwd=a9k2") };
        const patch = normalizeConfig({ "1": group("") }).config;

        const merged = mergeFileserveDraft(JSON.parse(base), patch, filled);
        expect(merged.moved).toBe(true);
        expect(merged.config["1"]!.url).toBe("https://pan.baidu.com/s/x?pwd=a9k2");
    });

    it("still lands a group the user added in that same stale draft", () => {
        const base = stored({ "1": group("") });
        const filled = { "1": group("https://pan.baidu.com/s/x?pwd=a9k2") };
        const patch = normalizeConfig({ "1": group(""), "2": group("", "quark") }).config;

        const merged = mergeFileserveDraft(JSON.parse(base), patch, filled);
        expect(merged.moved).toBe(true);
        expect(merged.config["1"]!.url).toBe("https://pan.baidu.com/s/x?pwd=a9k2");
        expect(merged.config["2"]!.netdisk).toBe("quark");
    });

    it("writes the draft through when nothing moved in the store", () => {
        const base = stored({ "1": group("") });
        const patch = normalizeConfig({ "1": group("https://pan.example/s/mine", "quark") }).config;

        const merged = mergeFileserveDraft(JSON.parse(base), patch, JSON.parse(base));
        expect(merged.moved).toBe(false);
        expect(merged.config["1"]!.url).toBe("https://pan.example/s/mine");
        expect(merged.config["1"]!.netdisk).toBe("quark");
    });

    it("honours a deliberate clear, and a deletion the store did not touch", () => {
        const base = stored({ "1": group(""), "2": group("") });
        // The panel dropped group 2; neither group moved in the store.
        const patch = normalizeConfig({ "1": group("") }).config;
        const merged = mergeFileserveDraft(JSON.parse(base), patch, JSON.parse(base));
        expect(Object.keys(merged.config)).toEqual(["1"]);
        expect(merged.moved).toBe(false);
    });

    it("reads a missing base as 'nothing known', so the patch stands", () => {
        const patch = normalizeConfig({ "1": group("") }).config;
        const merged = mergeFileserveDraft(null, patch, null);
        expect(merged.moved).toBe(false);
        expect(Object.keys(merged.config)).toEqual(["1"]);
    });
});

describe("fileserve model", () => {
    it("normalizes the canonical sample the aiya-core tests use", () => {
        const { config, errors } = normalizeConfig({
            "1": { adapter: "platform", url: "https://pan.example/s/abc", code: "x7k2", title: "夸克", price: 5 },
            "2": { adapter: "openlist_list", path: "/docs" },
        });
        expect(errors).toEqual([]);
        expect(config["1"]).toEqual({
            url: "https://pan.example/s/abc",
            code: "x7k2",
            title: "夸克",
            price: 5,
            adapter: "platform",
        });
        expect(config["2"]).toEqual({
            path: "/docs",
            password: "",
            per_page: 0,
            title: "",
            price: 0,
            adapter: "openlist_list",
        });
    });

    it("accepts the JSON-string shapes that arrive from the API", () => {
        const { config, errors } = normalizeConfig('{"7":{"adapter":"gofile_api","folder_id":"abc"}}');
        expect(errors).toEqual([]);
        expect(config["7"]?.adapter).toBe("gofile_api");
        expect(config["7"]?.folder_id).toBe("abc");
    });

    it("drops unknown keys and fills defaults", () => {
        const { config, errors } = normalizeConfig({
            "1": { adapter: "openlist_list", path: "/x", junk: 1, per_page: "10" },
        });
        expect(errors).toEqual([]);
        expect(config["1"]).toEqual({
            path: "/x",
            password: "",
            per_page: 10,
            title: "",
            price: 0,
            adapter: "openlist_list",
        });
    });

    it("folds the price to a non-negative int", () => {
        const { config } = normalizeConfig({ "1": { adapter: "platform", price: 4.9 } });
        expect(config["1"]?.price).toBe(4);
        const zero = normalizeConfig({ "1": { adapter: "platform", price: -5 } });
        expect(zero.config["1"]?.price).toBe(0);
    });

    it("refuses the whole save on an unknown adapter or non-numeric price", () => {
        expect(normalizeConfig({ "1": { adapter: "nope" } }).errors).toHaveLength(1);
        expect(normalizeConfig({ "1": { adapter: "platform", price: "abc" } }).errors).toHaveLength(1);
    });

    it("treats empty shapes as no configuration", () => {
        expect(normalizeConfig(null).config).toEqual({});
        expect(normalizeConfig("").config).toEqual({});
        expect(normalizeConfig([]).config).toEqual({});
        expect(normalizeConfig({}).config).toEqual({});
        expect(normalizeConfig("{}").config).toEqual({});
    });

    it("sanitizes group keys like the PHP side", () => {
        expect(sanitizeId("a b!!")).toBe("ab");
        expect(sanitizeId("x".repeat(20))).toHaveLength(16);
    });

    it("assigns the next free short id from the keys it can see", () => {
        const { config } = normalizeConfig({
            "1": { adapter: "platform" },
            "4": { adapter: "platform" },
        });
        expect(nextId(config)).toBe("5");
        const without = { ...config };
        delete without["4"];
        // The pure model only sees the current keys; the metabox keeps its
        // session history in the config it holds.
        expect(nextId(without)).toBe("2");
        expect(nextId({})).toBe("1");
    });

    it("builds an empty group for the editor with every declared field", () => {
        const group = emptyGroup("openlist_search");
        expect(ADAPTER_FIELDS.openlist_search!.map((field) => field.id)).toContain("keywords");
        expect(group).toMatchObject({ adapter: "openlist_search", keywords: "", parent: "", password: "", per_page: 0, title: "", price: 10 });
    });

    it("pre-fills the suggested price per adapter (pan links 2, everything else 10)", () => {
        expect(priceDefault("platform")).toBe(2);
        expect(priceDefault("openlist_list")).toBe(10);
        expect(priceDefault("openlist_search")).toBe(10);
        expect(priceDefault("gofile_api")).toBe(10);
        expect(priceDefault("unknown_adapter")).toBe(10);
        expect(emptyGroup("platform").price).toBe(2);
    });

    it("still normalizes site snapshots without a price to 0, unlike the editor prefill", () => {
        const { config } = normalizeConfig({ "1": { adapter: "platform", url: "https://x" } });
        expect(config["1"]?.price).toBe(0);
    });

    it("summarizes a config for the grid column", () => {
        const { config } = normalizeConfig({
            "1": { adapter: "platform", price: 5 },
            "2": { adapter: "openlist_list", price: 2 },
        });
        expect(configSummary(config)).toBe("2 组 · 7 分/次");
        expect(configSummary(null)).toBe("—");
    });

    it("keeps the local netdisk field through normalization and defaults platform groups", () => {
        const { config } = normalizeConfig({
            "1": { adapter: "platform", url: "https://x", netdisk: "quark" },
            "2": { adapter: "platform", url: "https://y" },
            "3": { adapter: "openlist_list", path: "/d", netdisk: "quark" },
        });
        expect(config["1"]?.netdisk).toBe("quark");
        // Untagged groups stay untagged (the lane treats them as baidu).
        expect(config["2"]?.netdisk).toBeUndefined();
        // The field is not platform-bound: any adapter may carry it.
        expect(config["3"]?.netdisk).toBe("quark");
    });

    it("strips the netdisk field and keeps only link-carrying groups for the payload", () => {
        const { config } = normalizeConfig({
            "1": { adapter: "platform", url: "https://x", netdisk: "baidu" },
            "2": { adapter: "platform", url: "", netdisk: "baidu" },
            "3": { adapter: "openlist_list", path: "/d" },
        });
        expect(productionConfig(config)).toEqual({
            "1": { adapter: "platform", url: "https://x", code: "", title: "", price: 0 },
            "3": { adapter: "openlist_list", path: "/d", password: "", per_page: 0, title: "", price: 0 },
        });

        // The site echo carries no ownership; the merge re-attaches it.
        const merged = JSON.parse(mergeRemoteFileserve(productionConfig(config), JSON.stringify(config))!);
        expect(merged["1"].netdisk).toBe("baidu");
        expect(merged["2"].netdisk).toBe("baidu");
        expect(merged["2"].url).toBe("");
        expect(merged["3"].netdisk).toBeUndefined();
    });

    it("a filled group missing from the site propagates its deletion on merge", () => {
        const local = JSON.stringify({
            "1": { adapter: "platform", url: "https://x", code: "", title: "", price: 0, netdisk: "baidu" },
            "2": { adapter: "platform", url: "", code: "", title: "", price: 0, netdisk: "baidu" },
        });
        // The site carries neither group: the filled one was deleted there
        // (deletion propagates), the empty one is pending lane work (stays).
        const merged = JSON.parse(mergeRemoteFileserve(null, local)!);
        expect(Object.keys(merged)).toEqual(["2"]);
    });
});

import { describe, expect, it } from "vitest";
import {
    ADAPTER_FIELDS,
    configSummary,
    emptyGroup,
    nextId,
    normalizeConfig,
    priceDefault,
    sanitizeId,
} from "../shared/fileserve.js";

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
});

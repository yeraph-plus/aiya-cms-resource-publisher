import { describe, expect, it } from "vitest";
import { groupTermsByRoot, mergeTermTokens, splitTermInput, termPath } from "../shared/terms.js";

const options = [
    { id: 7, name: "SOMEONE", slug: "someone" },
    { id: 12, name: "网盘", slug: "pan" },
];

describe("term input merge", () => {
    it("splits on 、 , and ，, trimming empties", () => {
        expect(splitTermInput("甲、乙, 丙 ，")).toEqual(["甲", "乙", "丙"]);
        expect(splitTermInput("")).toEqual([]);
        expect(splitTermInput("、、")).toEqual([]);
    });

    it("maps known names to id refs, case-insensitively (Latin folding)", () => {
        expect(mergeTermTokens([], ["SOMEONE", "网盘"], options)).toEqual(["7", "12"]);
        expect(mergeTermTokens([], ["someone"], options)).toEqual(["7"]);
    });

    it("turns unknown names into name: refs, deduped case-insensitively", () => {
        expect(mergeTermTokens([], ["新标签", "新标签", "XIN-biao"], options)).toEqual(["name:新标签", "name:XIN-biao"]);
        expect(mergeTermTokens(["name:xin-biao"], ["XIN-BIAO"], options)).toEqual(["name:xin-biao"]);
    });

    it("collapses a stale name: ref when the term now exists as an id", () => {
        expect(mergeTermTokens(["name:网盘"], ["网盘"], options)).toEqual(["12"]);
        expect(mergeTermTokens(["name:WANGPAN"], ["网盘"], options)).toEqual(["name:WANGPAN", "12"]);
    });

    it("keeps existing selection and skips duplicate id refs", () => {
        expect(mergeTermTokens(["7", "name:旧"], ["SOMEONE", "旧"], options)).toEqual(["7", "name:旧"]);
        expect(mergeTermTokens(["12"], ["网盘"], options)).toEqual(["12"]);
    });
});

describe("taxonomy hierarchy", () => {
    // 原作 (1) → 系列 (2) → 子系列 (3), a second root 漫画 (4) with one child,
    // and 孤儿 (6) whose parent (5) is not in the registry.
    const tree = [
        { id: 2, name: "系列", slug: "series", parent: 1 },
        { id: 1, name: "原作", slug: "origin", parent: 0 },
        { id: 3, name: "子系列", slug: "sub", parent: 2 },
        { id: 4, name: "漫画", slug: "comic", parent: 0 },
        { id: 6, name: "孤儿", slug: "orphan", parent: 5 },
        { id: 7, name: "单行本", slug: "tank", parent: 4 },
    ];

    it("builds the full path in root-first order, and just the name when flat", () => {
        expect(termPath({ id: 3, name: "子系列", slug: "sub", parent: 2 }, tree)).toBe("原作 / 系列 / 子系列");
        expect(termPath({ id: 1, name: "原作", slug: "origin", parent: 0 }, tree)).toBe("原作");
        expect(termPath({ id: 6, name: "孤儿", slug: "orphan", parent: 5 }, tree)).toBe("孤儿");
    });

    it("stops instead of looping on a parent cycle", () => {
        const cycle = [
            { id: 1, name: "甲", slug: "a", parent: 2 },
            { id: 2, name: "乙", slug: "b", parent: 1 },
        ];
        expect(termPath({ id: 1, name: "甲", slug: "a", parent: 2 }, cycle)).toBe("乙 / 甲");
    });

    it("groups children under their top-most ancestor, one group per line", () => {
        const groups = groupTermsByRoot(tree);
        // Group order follows the root's own position in the list (2 is first
        // here, 原作 is second), never a child's position.
        expect(groups.map((group) => group.root.id)).toEqual([1, 4, 6]);
        expect(groups[0]?.children.map((child) => child.id)).toEqual([2, 3]);
        expect(groups[1]?.children.map((child) => child.id)).toEqual([7]);
        expect(groups[2]?.children).toEqual([]);
    });

    it("treats a flat list as one group per term", () => {
        const flat = [
            { id: 1, name: "甲", slug: "a" },
            { id: 2, name: "乙", slug: "b" },
        ];
        const groups = groupTermsByRoot(flat);
        expect(groups.map((group) => group.root.id)).toEqual([1, 2]);
        expect(groups.every((group) => group.children.length === 0)).toBe(true);
    });
});

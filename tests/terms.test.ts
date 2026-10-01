import { describe, expect, it } from "vitest";
import { mergeTermTokens, splitTermInput } from "../shared/terms.js";

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

import { describe, expect, it } from "vitest";
import { parseSlugFromLink } from "../server/wp.js";

describe("parseSlugFromLink", () => {
    it("takes the last path segment", () => {
        expect(parseSlugFromLink("https://x.test/resource/501-abc/")).toBe("501-abc");
        expect(parseSlugFromLink("https://x.test/resource/501")).toBe("501");
    });

    it("answers null for plain permalinks and broken links", () => {
        expect(parseSlugFromLink("https://x.test/?p=501")).toBeNull();
        expect(parseSlugFromLink("not a url")).toBeNull();
    });

    it("decodes percent-encoded slugs", () => {
        expect(parseSlugFromLink("https://x.test/resource/%e6%96%87%e7%ab%a0")).toBe("文章");
    });
});

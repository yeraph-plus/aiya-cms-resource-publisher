import { describe, expect, it } from "vitest";
import { stagingDirName } from "../shared/staging-name.js";

// The one name this tool still builds: what a netdisk queue item carries for
// display. The userscript replaces it with its own CA{id} form, so these cases
// pin the readable half (title) and the part that must never drift (the id).

describe("queue folder label", () => {
    it("pads the id to 6 digits, sanitizes illegal characters and keeps CJK", () => {
        expect(stagingDirName(501, 'A/B:C*D?"E<F>G|H')).toBe("000501-A B C D E F G H");
        expect(stagingDirName(501, "测试 文章")).toBe("000501-测试 文章");
        expect(stagingDirName(7, "标题")).toBe("000007-标题");
        // Ids beyond six digits are not truncated.
        expect(stagingDirName(1234567, "标题").startsWith("1234567-")).toBe(true);
    });

    it("truncates the title to the budget at code points", () => {
        const long = stagingDirName(12345, "长".repeat(200));
        // 80 budget - 6 (id) - 1 (dash) = 73 title code points.
        expect(Array.from(long)).toHaveLength(80);
        expect(long.startsWith("012345-")).toBe(true);
    });

    it("strips trailing dots and spaces, and falls back on an empty title", () => {
        expect(stagingDirName(7, "标题...")).toBe("000007-标题");
        expect(stagingDirName(7, "   ")).toBe("000007-untitled");
    });
});

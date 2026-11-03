import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The userscript is one browser file with no import surface, so its naming
// contract is asserted against the source: the netdisk folder name is the
// script's own CA{padded id} shape, not the `000501-标题` label the queue
// carries for display.
const SCRIPT = fileURLToPath(new URL("../netdisk/aiya-netdisk.user.js", import.meta.url));

describe("netdisk folder naming", () => {
    const source = readFileSync(SCRIPT, "utf8");

    it("builds the name as CA plus the id padded to six digits", () => {
        expect(source).toMatch(/return `CA\$\{String\(postId\)\.padStart\(6, "0"\)\}`;/);
    });

    it("replaces the queue's label with its own name on load", () => {
        expect(source).toContain("dirName: folderName(item.postId)");
    });

    it("still recognizes folders made under the legacy id-prefixed name", () => {
        expect(source).toContain("name.startsWith(`${id}-`)");
    });
});

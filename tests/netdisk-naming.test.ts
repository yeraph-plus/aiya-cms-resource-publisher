import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The userscript is one browser file with no import surface, so its naming
// contract is asserted against the source: the netdisk folder name is the
// script's own CA{padded id} shape and deliberately does NOT follow the tool's
// 目录命名 setting (that setting only governs the local staging folder).
const SCRIPT = fileURLToPath(new URL("../netdisk/aiya-netdisk.user.js", import.meta.url));

describe("netdisk folder naming", () => {
    const source = readFileSync(SCRIPT, "utf8");

    it("builds the name as CA plus the id padded to six digits", () => {
        expect(source).toMatch(/return `CA\$\{String\(postId\)\.padStart\(6, "0"\)\}`;/);
    });

    it("overrides the queue's setting-derived dirName when loading the queue", () => {
        expect(source).toContain("dirName: folderName(item.postId)");
    });

    it("still recognizes folders made under the legacy id-prefixed name", () => {
        expect(source).toContain("name.startsWith(`${id}-`)");
    });
});

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The db module opens its file at import time — point it at a temp dir before
// the server module (and everything it pulls in) is imported.
process.env.PUBLISHER_DATA = mkdtempSync(join(tmpdir(), "publisher-shell-"));
// The default has to hold on its own, not because this machine exports it.
delete process.env.PUBLISHER_PORT;

const MAIN = fileURLToPath(new URL("../electron/main.mjs", import.meta.url));

describe("packaged shell port", () => {
    it("defaults to the 5175 the netdisk userscript points at", async () => {
        const { PUBLISHER_PORT } = await import("../server/index.js");
        expect(PUBLISHER_PORT).toBe(5175);
    });

    it("boots the bundle on that fixed port through the shared portguard", () => {
        const main = readFileSync(MAIN, "utf8");
        expect(main).toContain("listenWithPortguard");
        expect(main).toContain("PUBLISHER_PORT");
        // A random port would make the packaged app unreachable for the script.
        expect(main).not.toMatch(/port:\s*0\b/);
    });
});

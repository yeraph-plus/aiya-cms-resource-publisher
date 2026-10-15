/**
 * Build the intake window into a runnable bundle: esbuild turns intake/index.ts
 * (plus the shared registry it imports) into one file, and page.html is copied
 * next to it because the process reads it relative to its own module URL. The
 * desktop shell starts this bundle as a child process, so the packaged app
 * ships the whole 智能摄取 window instead of pointing at a port nothing binds.
 *
 * Usage: node scripts/build-intake.mjs
 */
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "dist-intake");

mkdirSync(outDir, { recursive: true });

await build({
    entryPoints: [path.join(root, "intake/index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(outDir, "index.js"),
    // Fastify's CommonJS internals call require("node:events") and friends; in
    // an ESM output that only resolves when a real require is in scope. Same
    // banner as the server bundle, same reason.
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});

copyFileSync(path.join(root, "intake/page.html"), path.join(outDir, "page.html"));
console.log("dist-intake/index.js + dist-intake/page.html");

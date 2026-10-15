/**
 * electron-builder wrapper that pins the download URLs so the local caches
 * (electron zip via @electron/get, nsis/winCodeSign toolsets) are always hit
 * with the same cache keys instead of reaching out to GitHub. The toolset
 * override points at a local static mirror serving the three 7z packages —
 * see README "桌面应用打包" for the one-time setup on a network-restricted
 * machine.
 *
 * Usage: node scripts/build-app.mjs win|dir [outputDir]
 *
 * The optional output directory exists for one real situation: a packaged copy
 * is already running, Windows locks its exe, and electron-builder cannot
 * replace the directory it lives in. Building beside it keeps the running app
 * untouched.
 */
import { spawnSync } from "node:child_process";

const target = process.argv[2] ?? "win";
const outputDir = process.argv[3];
process.env.ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/";
process.env.ELECTRON_BUILDER_BINARIES_ALLOW_HTTP = "true";
process.env.ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL = "http://localhost";

const args = target === "dir" ? ["--dir"] : ["--win"];
if (outputDir !== undefined && outputDir !== "") {
    args.push(`--config.directories.output=${outputDir}`);
}
const result = spawnSync("npx", ["electron-builder", ...args], { stdio: "inherit", shell: true });
process.exit(result.status ?? 1);

/**
 * The desktop packaging chain, wrapped so the Node ABI is restored no matter
 * how the run ends.
 *
 * Packaging has to swap better-sqlite3 to the Electron ABI for the
 * electron-builder window, then swap it back so vitest and tsx keep working
 * on Node. Chaining those steps with `&&` in package.json left the swap
 * half-applied whenever electron-builder failed (a download that could not
 * reach the toolset mirror, a full disk, a Ctrl+C), and the next `npm test`
 * then died on a NODE_MODULE_VERSION mismatch. The restore lives in a
 * `finally` here instead, so it runs on success, failure and interrupt alike.
 *
 * Usage: node scripts/app-build.mjs win|dir
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const target = process.argv[2] ?? "win";
if (target !== "win" && target !== "dir") {
    console.error("usage: node scripts/app-build.mjs win|dir");
    process.exit(1);
}

function run(command, args) {
    const result = spawnSync(command, args, { stdio: "inherit", shell: true, cwd: root });
    return result.status ?? 1;
}

const chain = [
    ["npm", ["run", "build"]],
    ["npm", ["run", "build:server"]],
    ["npm", ["run", "native:electron"]],
    ["node", ["scripts/build-app.mjs", target]],
];

let status = 0;
try {
    for (const [command, args] of chain) {
        status = run(command, args);
        if (status !== 0) {
            console.error(`\n${command} ${args.join(" ")} failed (exit ${status}) — stopping the packaging chain.`);
            break;
        }
    }
} finally {
    const restored = run("node", ["scripts/native-sync.mjs", "node"]);
    if (restored !== 0) {
        console.error("could not restore the Node ABI — run `npm run native:node` before the next test run.");
        if (status === 0) {
            status = restored;
        }
    }
}

process.exit(status);

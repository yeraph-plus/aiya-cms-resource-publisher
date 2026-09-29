/**
 * Swaps the better-sqlite3 native binary between the Node ABI (vitest, tsx)
 * and the Electron ABI (packaged app). Both prebuilds live in .native/ and
 * are fetched once per machine; see README "桌面应用打包".
 *
 * Usage: node scripts/native-sync.mjs node|electron
 */
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = path.join(root, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");

const which = process.argv[2];
if (which !== "node" && which !== "electron") {
    console.error("usage: node scripts/native-sync.mjs node|electron");
    process.exit(1);
}

const source = path.join(root, ".native", which, "better_sqlite3.node");
if (!existsSync(source)) {
    console.error(`missing ${source} — fetch both prebuilds first (see README)`);
    process.exit(1);
}
copyFileSync(source, target);
console.log(`better_sqlite3.node -> ${which} ABI`);

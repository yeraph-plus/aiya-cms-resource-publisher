/**
 * Mirrors the bundled plugin (wordpress_plugins/aiya-publish) into the
 * running WordPress install (../wp-content/plugins/aiya-publish). vendor/
 * on the target side is left alone — it holds the container-side QA tools
 * (phpunit/phpstan/phpcs) and is installed once, not synced.
 *
 * Usage: npm run plugin:sync
 */
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, "wordpress_plugins", "aiya-publish");
const target = path.join(root, "..", "wp-content", "plugins", "aiya-publish");

if (!existsSync(path.join(source, "aiya-publish.php"))) {
    console.error(`plugin source not found at ${source}`);
    process.exit(1);
}

/** Relative paths present on the target but gone from the source, vendor/ excepted. */
function staleFiles(base, rel = "") {
    const found = [];
    const dir = path.join(base, rel);
    for (const entry of readdirSync(dir)) {
        const relEntry = rel ? `${rel}/${entry}` : entry;
        if (relEntry === "vendor" || relEntry === ".git") {
            continue;
        }
        if (!existsSync(path.join(source, relEntry))) {
            found.push(relEntry);
        } else if (statSync(path.join(dir, entry)).isDirectory()) {
            found.push(...staleFiles(base, relEntry));
        }
    }
    return found;
}

const removed = existsSync(target) ? staleFiles(target) : [];

// Copy with the usual build exclusions; vendor/ is preserved by cpSync only
// when not overwritten — so filter it out of the copy entirely.
cpSync(source, target, {
    recursive: true,
    filter: (from) => !from.split(path.sep).includes(".git") && !from.split(path.sep).includes("vendor"),
});

for (const rel of removed) {
    rmSync(path.join(target, rel), { recursive: true, force: true });
}
console.log(`synced wordpress_plugins/aiya-publish -> wp-content/plugins/aiya-publish (${removed.length} stale entries removed)`);

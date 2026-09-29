/**
 * Packages the bundled WordPress plugin into a clean install-ready zip:
 * archives/aiya-cms-publish-<version>.zip with the deployment folder at the
 * archive root and everything development-only (tests, QA configs, composer
 * files) stripped.
 *
 * Mechanism: copy the source into a temp directory under the deployment slug
 * (dropping dev files during the copy), then hand it to the Windows-bundled
 * bsdtar — the Windows build writes real zips via "-a" but supports neither
 * GNU tar's flags nor "-s" name rewrites.
 *
 * Usage: npm run plugin:archive
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pluginDir = path.join(root, "wordpress_plugins", "aiya-cms-resource-publisher");
// The folder inside the zip is the folder WordPress installs: the slug of
// the deployment copy, not the source directory name.
const slug = "aiya-cms-publish";

const header = readFileSync(path.join(pluginDir, "aiya-publish.php"), "utf8");
const version = header.match(/^[\s*]*Version:[ \t]*(\S+)/m)?.[1];
if (!version) {
    console.error("could not read the plugin version from aiya-publish.php");
    process.exit(1);
}

const excludedNames = new Set([
    "tests",
    "composer.json",
    "composer.lock",
    "phpcs.xml.dist",
    "phpstan.neon.dist",
    "phpunit.xml.dist",
    ".git",
    ".gitignore",
    "node_modules",
    "vendor",
]);

// Staged inside archives/ so the archive lands next to it with a plain
// "../name.zip" relative path (bsdtar resolves it against its cwd).
const staging = mkdtempSync(path.join(root, "archives", ".staging-"));
const packed = path.join(staging, slug);
mkdirSync(packed);

for (const entry of readdirSync(pluginDir)) {
    if (excludedNames.has(entry)) {
        continue;
    }
    cpSync(path.join(pluginDir, entry), path.join(packed, entry), { recursive: true });
}

const outDir = path.dirname(staging);
const outName = `../${slug}-${version}.zip`;
const outFile = path.join(outDir, `${slug}-${version}.zip`);
rmSync(outFile, { force: true });

// The Windows-bundled bsdtar (System32), not the GNU tar on a Git Bash
// PATH: only bsdtar writes real zips via "-a".
execFileSync(
    "C:/Windows/System32/tar.exe",
    ["-a", "-cf", outName, slug],
    { cwd: staging, stdio: "inherit" },
);
rmSync(staging, { recursive: true, force: true });

const entries = execFileSync(
    "C:/Windows/System32/tar.exe",
    ["-tf", outFile],
    { encoding: "utf8" },
).split(/\r?\n/).filter(Boolean);

const dirty = entries.filter((entry) =>
    [...excludedNames].some((name) => entry === `${slug}/${name}/` || entry.startsWith(`${slug}/${name}/`)),
);
if (dirty.length > 0 || !entries.includes(`${slug}/aiya-publish.php`)) {
    console.error(`archive is not clean (${dirty.length} dev entries, main file present: ${entries.includes(`${slug}/aiya-publish.php`)})`);
    process.exit(1);
}

console.log(`archives/${slug}-${version}.zip — ${entries.length} entries, dev files excluded`);

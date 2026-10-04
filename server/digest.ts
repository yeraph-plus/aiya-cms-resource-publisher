/**
 * The completion flow's "nothing new to push" yardstick: a short digest over
 * a file list config. Key-order-insensitive canonical JSON, so the same
 * config built by different paths (normalizeConfig vs the site's stored
 * shape) always hashes alike. Server-only — node:crypto never enters the
 * web bundle.
 */

import { createHash } from "node:crypto";

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

/** 16 hex chars — enough to tell "changed" from "unchanged", cheap to store. */
export function configDigest(config: unknown): string {
    return createHash("sha256").update(canonicalJson(config)).digest("hex").slice(0, 16);
}

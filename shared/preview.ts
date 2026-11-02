/**
 * The preview document: the post source rendered the way the site will render
 * it, with two adjustments the local tool needs.
 *
 * Staged images (`file://…`) are rewritten to the local file route, because a
 * browser refuses to load `file://` subresources from an http page — the
 * stored source keeps the real path, the preview gets a URL it can show.
 *
 * Everything else is passed through untouched: the source comes from the site,
 * a CSV or an agent, so it may well contain script. Isolation is the caller's
 * job (a `sandbox`ed iframe without `allow-scripts`), not a sanitizer's — a
 * hand-rolled allowlist would drop the `[ref]` shortcodes and the markup this
 * tool exists to preserve.
 */

import { localImagePath, localImageSources, replaceImageSources } from "./image-upload.js";

export interface PreviewOptions {
    /** Used as the base for body-relative image and link targets. */
    siteUrl: string;
    /** Absolute URL the preview can load for a staged file on this machine. */
    localImageUrl: (path: string) => string;
}

const STYLE = `
body { margin: 16px; font: 14px/1.8 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #171717; }
img { max-width: 100%; height: auto; border-radius: 4px; }
p { margin: 0 0 12px; }
pre { background: #f5f5f5; padding: 10px; border-radius: 4px; overflow: auto; }
code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
blockquote { margin: 0 0 12px; padding-left: 12px; border-left: 3px solid #d4d4d4; color: #525252; }
hr { border: 0; border-top: 1px solid #e5e5e5; margin: 18px 0; }
a { color: #2563eb; }
table { border-collapse: collapse; }
td, th { border: 1px solid #e5e5e5; padding: 4px 8px; }
.missing { color: #b91c1c; font-size: 12px; }
`;

function escapeAttribute(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildPreviewDoc(content: string, options: PreviewOptions): string {
    const mapping = new Map<string, string>();
    for (const src of localImageSources(content)) {
        const path = localImagePath(src);
        if (path !== null) {
            mapping.set(src, options.localImageUrl(path));
        }
    }
    // A link would navigate this frame away from the preview (and popups are
    // sandboxed off), so the target goes and the text stays.
    const body = replaceImageSources(content, mapping).replace(/<a\b[^>]*>/gi, "<a>");
    const site = options.siteUrl.trim().replace(/\/+$/, "");
    const base = site === "" ? "" : `<base href="${escapeAttribute(site)}/">`;
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
${base}
<style>${STYLE}</style>
</head>
<body>${body}</body>
</html>`;
}

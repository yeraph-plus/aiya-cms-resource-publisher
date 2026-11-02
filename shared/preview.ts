/**
 * The preview document: the post source rendered the way the site will render
 * it, with two adjustments the local tool needs.
 *
 * Staged images (`file://…`) are rewritten to the local file route, because a
 * browser refuses to load `file://` subresources from an http page — the
 * stored source keeps the real path, the preview gets a URL it can show.
 *
 * Paragraphs are rebuilt from blank lines, the way WordPress does it. The
 * site's body is `wpautop`'d on render and WP stores no `<p>`, so most
 * sources are plain text with blank lines between paragraphs — shown raw, a
 * browser would collapse every one of them into a single run-on paragraph and
 * the preview would misrepresent the post it exists to check.
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

/**
 * A chunk that already opens on markup is left alone: it is either a block the
 * author wrote (`<ul>`, `<blockquote>`, `<hr />`) or a `<p>` from stored data,
 * and wrapping it again would nest a paragraph inside a paragraph. A shortcode
 * is left alone too — it is replaced at render time on the site, and wrapping
 * it in a `<p>` here would show the literal tag inside a paragraph of its own.
 */
const ALREADY_MARKUP = /^<(\/?)(p|h[1-6]|ul|ol|li|dl|dt|dd|blockquote|hr|img|figure|figcaption|table|thead|tbody|tr|td|th|div|details|summary|pre|section|article|alert)\b/i;

/**
 * Rebuilds paragraphs and line breaks the way `wpautop` does: a blank line
 * starts a new paragraph, a single newline is a `<br />`.
 */
export function paragraphize(content: string): string {
    return content
        .split(/\r?\n[ \t]*\r?\n/)
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk !== "")
        .map((chunk) => {
            if (ALREADY_MARKUP.test(chunk) || chunk.startsWith("[")) {
                return chunk;
            }
            return `<p>${chunk.replace(/[ \t]*\r?\n[ \t]*/g, "<br />\n")}</p>`;
        })
        .join("\n");
}

/**
 * A blockquote holds one field per line and the site turns those into `<br />`
 * too (`wpautop` does not skip blockquotes). Plain text inside one is folded
 * onto a single line by the browser otherwise, which makes a specs block look
 * like a run-on sentence in the preview only.
 */
function breakLinesInBlockquotes(html: string): string {
    return html.replace(/<blockquote(?:\s[^>]*)?>([\s\S]*?)<\/blockquote>/gi, (whole, inner: string) => {
        if (/<p[\s>]|<\/p>|<br\s*\/?>/i.test(inner)) {
            return whole;
        }
        const broken = inner.trim().replace(/[ \t]*\r?\n[ \t]*/g, "<br />\n");
        return whole.replace(inner, broken);
    });
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
    const body = replaceImageSources(breakLinesInBlockquotes(paragraphize(content)), mapping).replace(
        /<a\b[^>]*>/gi,
        "<a>",
    );
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

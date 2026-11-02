/**
 * Pure helpers behind the detail panel's image drop zone: turn the picked file
 * into the wire form, stage it locally, and keep the tag shape in one place so
 * the inserted markup is identical wherever it comes from.
 * No DOM and no fetch here — the caller owns both.
 */

/** ArrayBuffer → base64. Chunked: a 10MB file would blow the argument limit. */
export function toBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
    }
    return btoa(binary);
}

/** The markup one image contributes to the post source. */
export function imageTag(url: string, alt = ""): string {
    return `<img src="${url}" alt="${alt}">`;
}

/**
 * Puts the picked images at the very start of the post source, in the order
 * they were picked. Where they land is part of the publishing contract rather
 * than a preference: the site builds the cover from the first image of the
 * body, and the cover pipeline runs on push. Leading blank lines are folded
 * away so dropping twice in a row does not stack empty lines above the images.
 */
export function prependImageTags(content: string, urls: string[]): string {
    const tags = urls.map((url) => imageTag(url)).join("\n");
    if (tags === "") {
        return content;
    }
    const body = content.replace(/^\n+/, "");
    return body === "" ? tags : `${tags}\n${body}`;
}

// --- 本地暂存（推送时才上传）------------------------------------------------
// An image picked in the panel is copied into the app's own images directory
// and the source keeps a `file://` reference to that real absolute path, so
// editing never touches the network and the markup still names the one file
// on this machine. Only `runPush` turns these references into site URLs.
//
// The reference is a URL rather than a bare path because it has to survive a
// round trip through an HTML attribute and a dialog copy: `file:///D:/a.png`
// parses unambiguously, `D:\a.png` does not.

/** src form stored for a staged image: `D:\a b\图.png` → `file:///D:/a%20b/%E5%9B%BE.png`. */
export function localImageSrc(path: string): string {
    const slash = path.replace(/\\/g, "/");
    const absolute = slash.startsWith("/") ? slash : `/${slash}`;
    const encoded = absolute
        .split("/")
        .map((segment, index) => (index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
        .join("/");
    return `file://${encoded}`;
}

/**
 * The absolute path behind a local reference, or null when the src is a site
 * URL. Both the staged `file://` form and a hand-written Windows path are
 * understood; a leading `/…` is deliberately not treated as local, because
 * that is how the site's own body-relative images start.
 */
export function localImagePath(src: string): string | null {
    const value = src.trim();
    if (/^file:\/\//i.test(value)) {
        const rest = value.slice("file://".length);
        // Only the empty-host form is ours: file:///D:/x or file:///home/x.
        if (!rest.startsWith("/")) {
            return null;
        }
        const withoutSlash = /^\/[A-Za-z]:/.test(rest) ? rest.slice(1) : rest;
        try {
            return decodeURIComponent(withoutSlash);
        } catch {
            return withoutSlash;
        }
    }
    if (/^[A-Za-z]:[\\/]/.test(value)) {
        return value.replace(/\//g, "\\");
    }
    return null;
}

/** Matches the src attribute of an image tag, single- or double-quoted. */
const IMG_SRC = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/** Every distinct local reference in the source, in document order. */
export function localImageSources(content: string): string[] {
    const found: string[] = [];
    for (const match of content.matchAll(IMG_SRC)) {
        const src = match[1] ?? match[2] ?? "";
        if (localImagePath(src) !== null && !found.includes(src)) {
            found.push(src);
        }
    }
    return found;
}

/**
 * Rewrites exactly the references in `mapping` and leaves every other byte of
 * the source alone — a push that uploaded one image must not reformat the
 * rest of a post the user is still editing.
 */
export function replaceImageSources(content: string, mapping: Map<string, string>): string {
    if (mapping.size === 0) {
        return content;
    }
    return content.replace(IMG_SRC, (whole, doubleQuoted: string | undefined, singleQuoted: string | undefined) => {
        const src = doubleQuoted ?? singleQuoted ?? "";
        const next = mapping.get(src);
        return next === undefined ? whole : whole.replace(src, next);
    });
}

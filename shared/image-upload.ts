/**
 * Pure helpers behind the detail panel's image button: turn the picked file
 * into the wire form, splice the tag into the content, and keep the tag shape
 * in one place so the inserted markup is identical wherever it comes from.
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

/** The markup one uploaded image contributes to the post source. */
export function imageTag(url: string, alt = ""): string {
    return `<img src="${url}" alt="${alt}">`;
}

/**
 * Splices `text` into `content` at `caret`, clamped to the content's bounds —
 * a stale caret (the field was emptied elsewhere) lands at the end instead of
 * throwing or dropping the tag.
 */
export function insertAtCaret(content: string, text: string, caret: number): string {
    const at = Math.min(Math.max(Math.trunc(caret) || 0, 0), content.length);
    return content.slice(0, at) + text + content.slice(at);
}

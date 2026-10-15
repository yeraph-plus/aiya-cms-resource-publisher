/**
 * Pure helpers behind the detail panel's image drop zone: turn the picked file
 * into the wire form, splice the tags into the content, and keep the tag shape
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
 * Puts the uploaded images at the very start of the post source, in the order
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

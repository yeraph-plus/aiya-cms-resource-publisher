/**
 * The staged folder's name, shared by the two independent consumers: the
 * netdisk lane (queue items hand the name to the userscript, which creates
 * the folder netdisk-side) and the local staging helper (dirs.ts creates a
 * same-named folder on disk). The post id zero-padded to five digits plus
 * the sanitized title — file managers sort folders in posting order.
 */

/** Whole-name budget in code points — well under the filesystem's 255-char
 * cap and comfortable inside any netdisk path limit. */
const MAX_NAME = 80;

/** The post id segment, zero-padded to 5 digits so file managers sort the
 * folders in posting order. */
export function stagingId(postId: number): string {
    return String(postId).padStart(5, "0");
}

export function stagingDirName(postId: number, title: string): string {
    const id = stagingId(postId);
    const cleaned = title
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/[ .]+$/, "")
        .trim();
    const budget = MAX_NAME - id.length - 1;
    // Array.from walks code points, so astral chars (emoji) are not split.
    const truncated = Array.from(cleaned)
        .slice(0, Math.max(1, budget))
        .join("")
        .trim();
    return `${id}-${truncated === "" ? "untitled" : truncated}`;
}

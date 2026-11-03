/**
 * The folder name this tool hands a netdisk pipeline: the post id zero-padded
 * to six digits, then a sanitized title. The 百度 userscript overrides it with
 * its own `CA{id}` form before touching the netdisk (see
 * `netdisk/aiya-netdisk.user.js`), so what leaves here is a readable label —
 * the id segment is the load-bearing part, and it is what a copy of that script
 * from before the override falls back to.
 */

/** Whole-name budget in code points — well under the filesystem's 255-char
 * cap and comfortable inside any netdisk path limit. */
const MAX_NAME = 80;

/** The post id segment, zero-padded to 6 digits so file managers sort the
 * folders in posting order. */
function stagingId(postId: number): string {
    return String(postId).padStart(6, "0");
}

function sanitizeSuffix(part: string): string {
    return part
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/[ .]+$/, "")
        .trim();
}

/** `000501-标题`. An empty title degrades to "untitled" — the leading id is
 * the identity either way. */
export function stagingDirName(postId: number, title: string): string {
    const id = stagingId(postId);
    const cleaned = sanitizeSuffix(title);
    const budget = MAX_NAME - id.length - 1;
    // Array.from walks code points, so astral chars (emoji) are not split.
    const truncated = Array.from(cleaned)
        .slice(0, Math.max(1, budget))
        .join("")
        .trim();
    return `${id}-${truncated === "" ? "untitled" : truncated}`;
}

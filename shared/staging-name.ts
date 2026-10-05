/**
 * The staged folder's name, shared by the two independent consumers: the
 * netdisk lane (queue items hand the name to the userscript, which creates
 * the folder netdisk-side) and the local staging helper (dirs.ts creates a
 * same-named folder on disk). The post id zero-padded to six digits plus a
 * configurable suffix (slug / title / none — the tool setting 目录命名).
 *
 * Identification is always the leading id, compared numerically: folder
 * names created under older padding (or hand-renamed suffixes) still match.
 */

export type DirNameSuffix = "slug" | "title" | "none";

export const DIR_NAME_SUFFIXES: DirNameSuffix[] = ["slug", "title", "none"];

export function coerceDirNameSuffix(raw: string): DirNameSuffix {
    return DIR_NAME_SUFFIXES.includes(raw as DirNameSuffix) ? (raw as DirNameSuffix) : "title";
}

/** Whole-name budget in code points — well under the filesystem's 255-char
 * cap and comfortable inside any netdisk path limit. */
const MAX_NAME = 80;

/** The post id segment, zero-padded to 6 digits so file managers sort the
 * folders in posting order. */
export function stagingId(postId: number): string {
    return String(postId).padStart(6, "0");
}

function sanitizeSuffix(part: string): string {
    return part
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/[ .]+$/, "")
        .trim();
}

/** The staged folder's name: padded id, then the configured suffix. A slug
 * falls back to the title when the row has none yet, and an empty title
 * degrades to "untitled" — the leading id is the identity either way. */
export function stagingDirName(
    postId: number,
    parts: { title: string; slug: string | null; suffix: DirNameSuffix },
): string {
    const id = stagingId(postId);
    if (parts.suffix === "none") {
        return id;
    }
    const raw = parts.suffix === "slug" ? (parts.slug ?? parts.title) : parts.title;
    const cleaned = sanitizeSuffix(raw);
    const budget = MAX_NAME - id.length - 1;
    // Array.from walks code points, so astral chars (emoji) are not split.
    const truncated = Array.from(cleaned)
        .slice(0, Math.max(1, budget))
        .join("")
        .trim();
    return `${id}-${truncated === "" ? "untitled" : truncated}`;
}

/** Whether a folder name belongs to the post: the name must equal the padded
 * id or open with it plus the dash delimiter (which keeps 000500 from
 * claiming 0005001's folder). No legacy shapes — the tool only ever created
 * this one form. */
export function stagingNameMatches(name: string, postId: number): boolean {
    const id = stagingId(postId);
    return name === id || name.startsWith(`${id}-`);
}

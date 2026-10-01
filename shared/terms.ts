/**
 * Taxonomy term reference merging for the detail editor. Refs are "81" (term
 * id 81) or "name:标签" (a term to create on push). Both input methods — the
 * free-text input and the checkbox list — funnel into this one merge, which
 * dedupes by identity: a known name collapses to its id ref (dropping any
 * stale name: ref for the same term), unknown names become name: refs deduped
 * case-insensitively.
 */

export interface TermOption {
    id: number;
    name: string;
    slug: string;
}

/** Split a raw input value into trimmed, non-empty tokens ("、" ", "，" all separate). */
export function splitTermInput(raw: string): string[] {
    return raw
        .split(/[、,，]/)
        .map((token) => token.trim())
        .filter(Boolean);
}

export function mergeTermTokens(current: string[], tokens: string[], options: TermOption[]): string[] {
    const next = [...current];
    for (const token of tokens) {
        const option = options.find((candidate) => candidate.name.toLowerCase() === token.toLowerCase());
        if (option) {
            const ref = String(option.id);
            const stale = next.findIndex(
                (item) => item.startsWith("name:") && item.slice("name:".length).toLowerCase() === token.toLowerCase(),
            );
            if (stale >= 0) {
                next.splice(stale, 1);
            }
            if (!next.includes(ref)) {
                next.push(ref);
            }
        } else if (
            !next.some((item) => item.startsWith("name:") && item.slice("name:".length).toLowerCase() === token.toLowerCase())
        ) {
            next.push(`name:${token}`);
        }
    }
    return next;
}

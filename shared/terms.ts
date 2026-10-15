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
    /** Hierarchical taxonomies (分类) only: parent term id, 0 = top level. */
    parent?: number;
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

/**
 * A term's full display path, root first: "原作 / 系列 / 子分类". Flat terms
 * (parent 0, the other five taxonomies) come back as just their name, so one
 * helper serves both. A broken chain — a parent that is missing from the
 * registry, or a cycle — stops there instead of looping, because term data
 * comes from the site and must not be able to hang the editor.
 */
export function termPath(term: TermOption, options: TermOption[]): string {
    const parts: string[] = [term.name];
    const seen = new Set<number>([term.id]);
    let parent = term.parent ?? 0;
    while (parent !== 0 && !seen.has(parent)) {
        const next = options.find((candidate) => candidate.id === parent);
        if (!next) {
            break;
        }
        seen.add(next.id);
        parts.unshift(next.name);
        parent = next.parent ?? 0;
    }
    return parts.join(" / ");
}

export interface TermGroup {
    /** The top-most ancestor (itself, for a term with no parent). */
    root: TermOption;
    /** Everything below that root, in the incoming order; may be empty. */
    children: TermOption[];
}

/**
 * Hierarchical terms grouped by their top-most ancestor, for the editor's
 * "one root per line, its children beside it" layout. Group order follows the
 * root's own position in the incoming list (callers sort by usefulness), and
 * a term whose ancestors are missing from the registry is a root of its own.
 */
export function groupTermsByRoot(options: TermOption[]): TermGroup[] {
    const byId = new Map<number, TermOption>();
    for (const option of options) {
        byId.set(option.id, option);
    }

    const groups = new Map<number, TermGroup>();
    const rootOf = (term: TermOption): TermOption => {
        const seen = new Set<number>([term.id]);
        let current = term;
        while ((current.parent ?? 0) !== 0) {
            const parent = byId.get(current.parent ?? 0);
            if (!parent || seen.has(parent.id)) {
                break;
            }
            seen.add(parent.id);
            current = parent;
        }
        return current;
    };

    for (const option of options) {
        const root = rootOf(option);
        let group = groups.get(root.id);
        if (!group) {
            group = { root, children: [] };
            groups.set(root.id, group);
        }
        if (option.id !== root.id) {
            group.children.push(option);
        }
    }

    // Roots first in their own list order: a child that sorts high must not
    // pull its whole branch to the top of the field.
    const ordered = [...groups.values()];
    ordered.sort((a, b) => options.indexOf(a.root) - options.indexOf(b.root));
    return ordered;
}

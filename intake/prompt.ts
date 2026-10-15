/**
 * The user-turn assembly: the vocabulary the model may use, then the raw
 * corpus. The taxonomy names come from the publisher's shared registry rather
 * than a local copy — that list is the one thing both sides must agree on, and
 * duplicating it would only create a way for them to disagree.
 */

import { TAXONOMY_LABELS, TAXONOMY_ORDER } from "../shared/import.js";

export interface VocabularyEntry {
    name: string;
    count: number;
    /** Hierarchical taxonomies: the "父 / 子" path the model must copy whole. */
    path?: string;
}

export type Vocabulary = Record<string, VocabularyEntry[]>;

/** A vocabulary line longer than this is noise, not guidance. */
const MAX_ENTRIES_PER_TAXONOMY = 300;

export function buildUserMessage(corpus: string, vocabulary: Vocabulary): string {
    const lines: string[] = [
        "【可用标签词表】括号里是本站已用次数，次数越高越可能是正确用词；只能逐字照抄这里的词。分类是层级词法，列出的「父 / 子」路径要整条照抄，不要只写最后一段。",
    ];
    for (const taxonomy of TAXONOMY_ORDER) {
        const label = TAXONOMY_LABELS[taxonomy] ?? taxonomy;
        const list = (vocabulary[taxonomy] ?? []).slice(0, MAX_ENTRIES_PER_TAXONOMY);
        if (list.length === 0) {
            lines.push(`- ${label}（${taxonomy}）：暂无词表，确需时按词法写进 newTerms。`);
            continue;
        }
        const words = list
            .map((entry) => {
                const word = entry.path ?? entry.name;
                return entry.count > 0 ? `${word}(${entry.count})` : word;
            })
            .join("、");
        lines.push(`- ${label}（${taxonomy}）：${words}`);
    }

    lines.push("", "【原始语料】", corpus.trim());
    return lines.join("\n");
}
import type { PostRow, Snapshot } from "./db.js";
import type { PushPayload, PushTermRef } from "./wp.js";

function parseSnapshot(raw: string | null): Snapshot | null {
    if (!raw) {
        return null;
    }
    try {
        return JSON.parse(raw) as Snapshot;
    } catch {
        return null;
    }
}

function refsToPayload(refs: Record<string, string[]>): Record<string, PushTermRef[]> {
    const payload: Record<string, PushTermRef[]> = {};
    for (const [taxonomy, list] of Object.entries(refs)) {
        payload[taxonomy] = list.map((ref) =>
            ref.startsWith("name:") ? ref.slice("name:".length) : Number(ref),
        );
    }
    return payload;
}

/**
 * The whole-row payload. The date rides along only when the row's date
 * differs from its confirmed snapshot — echoing an unchanged date back would
 * suppress the server-side "fileserve changed → refresh publish moment" rule.
 * A new row always sends its date (the creation moment, or whatever the user
 * backdated it to).
 */
export function buildPayload(row: PostRow, termRefs: Record<string, string[]>): PushPayload {
    const snapshot = parseSnapshot(row.snapshot);
    const payload: PushPayload = {
        title: row.title,
        content: row.content,
        status: row.status,
        terms: refsToPayload(termRefs),
        fileserve: row.fileserve ? JSON.parse(row.fileserve) : null,
    };
    if (row.authorId) {
        payload.authorId = row.authorId;
    }
    const dateChanged = !snapshot || row.dateLocal !== snapshot.dateLocal;
    if (row.dateLocal !== "" && (!row.postId || dateChanged)) {
        payload.date = row.dateLocal;
    }
    return payload;
}

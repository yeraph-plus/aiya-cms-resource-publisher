import {
    getPostByRemoteId,
    getSettings,
    insertPost,
    listPosts,
    logEvent,
    parseSnapshot,
    replaceTerms,
    setSetting,
    setTermRefs,
    snapshotFromRemote,
    updatePostRow,
    upsertAuthor,
    type PostRow,
} from "./db.js";
import { listResources, parseSlugFromLink, ping, taxonomies, users, WpError, type WpItem } from "./wp.js";
import { setProgress } from "./progress.js";

export interface SyncOutcome {
    ok: boolean;
    error: string | null;
    fetched: number;
    created: number;
    refreshed: number;
    conflicts: number;
    missing: number;
    /** Items that could not be merged (malformed remote data) and were passed over. */
    skipped: number;
}

function creds() {
    const settings = getSettings();
    return {
        siteUrl: settings.siteUrl,
        username: settings.username,
        appPassword: settings.appPassword,
        proxyUrl: settings.proxyUrl,
    };
}

function message(error: unknown): string {
    if (error instanceof WpError) {
        return `HTTP ${error.status}：${error.message}`;
    }
    return String(error);
}

function now(): string {
    return new Date().toISOString();
}

function remoteToState(item: WpItem): {
    status: string;
    title: string;
    content: string;
    authorId: number;
    dateLocal: string;
    dateGmt: string;
    modifiedGmt: string;
    fileserve: string | null;
    slug: string | null;
    termRefs: Record<string, string[]>;
} {
    const termRefs: Record<string, string[]> = {};
    for (const [taxonomy, terms] of Object.entries(item.terms ?? {})) {
        termRefs[taxonomy] = terms.map((term) => String(term.id));
    }
    return {
        status: item.status,
        title: item.title,
        content: item.content,
        authorId: item.authorId,
        dateLocal: item.date,
        dateGmt: item.dateGmt,
        modifiedGmt: item.modifiedGmt,
        fileserve: item.fileserve ? JSON.stringify(item.fileserve) : null,
        slug: parseSlugFromLink(item.link),
        termRefs,
    };
}

function mergeRemote(item: WpItem, outcome: SyncOutcome): void {
    upsertAuthor(item.authorId, item.authorName);
    const remote = remoteToState(item);
    const existing: PostRow | undefined = getPostByRemoteId(item.id);

    if (!existing) {
        const localId = insertPost({
            postId: item.id,
            status: remote.status,
            title: remote.title,
            content: remote.content,
            authorId: remote.authorId,
            dateLocal: remote.dateLocal,
            dateGmt: remote.dateGmt,
            modifiedGmt: remote.modifiedGmt,
            fileserve: remote.fileserve,
            slug: remote.slug,
            dirty: false,
            conflict: false,
            missing: false,
            lastSyncedGmt: now(),
            snapshot: JSON.stringify(snapshotFromRemote(item, remote.termRefs)),
        });
        setTermRefs(localId, remote.termRefs);
        outcome.created += 1;
        return;
    }

    if (existing.dirty) {
        // Local edits win; only flag the conflict when the online post moved
        // past the version this row was based on. The slug is not an editable
        // field, so it backfills even on dirty rows.
        const snapshot = parseSnapshot(existing.snapshot);
        if (snapshot && remote.modifiedGmt > snapshot.modifiedGmt) {
            updatePostRow(existing.localId, { slug: remote.slug, conflict: true, missing: false, lastSyncedGmt: now() });
            outcome.conflicts += 1;
            return;
        }
        updatePostRow(existing.localId, { slug: remote.slug, missing: false, lastSyncedGmt: now() });
        outcome.refreshed += 1;
        return;
    }

    updatePostRow(existing.localId, {
        status: remote.status,
        title: remote.title,
        content: remote.content,
        authorId: remote.authorId,
        dateLocal: remote.dateLocal,
        dateGmt: remote.dateGmt,
        modifiedGmt: remote.modifiedGmt,
        fileserve: remote.fileserve,
        slug: remote.slug,
        dirty: false,
        conflict: false,
        missing: false,
        lastSyncedGmt: now(),
        snapshot: JSON.stringify(snapshotFromRemote(item, remote.termRefs)),
    });
    setTermRefs(existing.localId, remote.termRefs);
    outcome.refreshed += 1;
}

/**
 * Pull the site into the local database. First sync is a full sweep; after
 * that only posts modified since the last cursor are fetched. Rows with local
 * edits are never overwritten — a genuine upstream change marks them as
 * conflicting instead.
 */
export async function runSync(): Promise<SyncOutcome> {
    const outcome: SyncOutcome = { ok: false, error: null, fetched: 0, created: 0, refreshed: 0, conflicts: 0, missing: 0, skipped: 0 };
    const settings = getSettings();
    if (!settings.siteUrl || !settings.username || !settings.appPassword) {
        outcome.error = "先在设置里填好站点地址、用户名和应用密码。";
        return outcome;
    }

    const site = creds();
    let probe;
    try {
        setProgress({ phase: "连接站点", done: 0, total: 0 });
        probe = await ping(site);
    } catch (error) {
        outcome.error = message(error);
        logEvent("error", "同步", `连接失败：${outcome.error}`);
        return outcome;
    }
    if (!probe.resourceAvailable) {
        outcome.error = "站点上没有 resource 文章类型（aiya-core 未启用？）。";
        logEvent("error", "同步", outcome.error);
        return outcome;
    }

    try {
        // The authoritative author list: everyone who can author a post
        // online. Local remarks survive; ids/names refresh from the site.
        setProgress({ phase: "拉取作者", done: 0, total: 0 });
        for (const user of await users(site)) {
            upsertAuthor(user.id, user.name);
        }

        setProgress({ phase: "拉取术语", done: 0, total: 0 });
        replaceTerms(await taxonomies(site));

        const cursor = settings.lastSyncCursor;
        const incremental = Boolean(cursor);
        const perPage = 50;
        let page = 1;
        const seen = new Set<number>();
        let maxModified = cursor ?? "";
        const box: { total: number | null } = { total: null };

        for (;;) {
            const { items, total } = await listResources(site, page, perPage, incremental ? (cursor ?? undefined) : undefined);
            if (box.total === null && total !== null) {
                box.total = total;
            }
            setProgress({ phase: "拉取资源", done: outcome.fetched, total: box.total ?? 0 });
            for (const item of items) {
                // One malformed item must not kill the whole pull: merge it
                // in isolation, count the skip, keep paging. The id lands in
                // `seen` before the merge so a skipped item's local row is
                // not misread as "missing on the site" by the sweep below.
                try {
                    seen.add(item.id);
                    // A row the publisher itself pushed a moment ago can come
                    // back mid-sync; merging it is harmless — dirty rows keep
                    // their local state.
                    mergeRemote(item, outcome);
                } catch {
                    outcome.skipped += 1;
                    logEvent("warn", "同步", `#${item.id} ${item.title}：数据无法合并，已跳过`, item.id);
                    continue;
                }
                if (item.modifiedGmt > maxModified) {
                    maxModified = item.modifiedGmt;
                }
            }
            outcome.fetched += items.length;
            setProgress({ phase: "拉取资源", done: outcome.fetched, total: box.total ?? outcome.fetched });
            if (items.length < perPage) {
                break;
            }
            page += 1;
        }

        if (!incremental) {
            setProgress({ phase: "核对缺失", done: 0, total: 0 });
            for (const row of listPosts()) {
                const gone = row.postId !== null && !seen.has(row.postId);
                if (gone !== row.missing) {
                    updatePostRow(row.localId, { missing: gone });
                }
                if (gone) {
                    outcome.missing += 1;
                }
            }
        }

        if (maxModified !== "") {
            // WP datetimes are second-granular and modified_after compares
            // strictly, so posts modified within the same second as the
            // cursor could be skipped by the next pull. Step the cursor back
            // one second — re-merging an already-seen row is harmless.
            const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(maxModified);
            if (m) {
                const boundary = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
                boundary.setUTCSeconds(boundary.getUTCSeconds() - 1);
                setSetting("lastSyncCursor", boundary.toISOString().slice(0, 19));
            } else {
                setSetting("lastSyncCursor", maxModified);
            }
        }
        outcome.ok = true;
        logEvent(
            "info",
            "同步",
            `拉取完成：获取 ${outcome.fetched}，新增 ${outcome.created}，刷新 ${outcome.refreshed}，冲突 ${outcome.conflicts}，线上缺失 ${outcome.missing}` +
                (outcome.skipped > 0 ? `，跳过畸形 ${outcome.skipped}` : ""),
        );
        return outcome;
    } catch (error) {
        outcome.error = message(error);
        logEvent("error", "同步", `拉取中断：${outcome.error}`);
        return outcome;
    }
}

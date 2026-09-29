import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const dataDir = process.env.PUBLISHER_DATA ?? process.cwd();
mkdirSync(dataDir, { recursive: true });

export const dbPath = join(dataDir, "publisher.db");
export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS authors (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    remark TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS terms (
    taxonomy TEXT NOT NULL,
    term_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    PRIMARY KEY (taxonomy, term_id)
);
CREATE TABLE IF NOT EXISTS posts (
    local_id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER,
    status TEXT NOT NULL DEFAULT 'publish',
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    author_id INTEGER,
    date_local TEXT NOT NULL DEFAULT '',
    date_gmt TEXT NOT NULL DEFAULT '',
    modified_gmt TEXT NOT NULL DEFAULT '',
    fileserve TEXT,
    dirty INTEGER NOT NULL DEFAULT 0,
    conflict INTEGER NOT NULL DEFAULT 0,
    missing INTEGER NOT NULL DEFAULT 0,
    last_synced_gmt TEXT,
    last_pushed_gmt TEXT,
    last_error TEXT,
    snapshot TEXT
);
CREATE INDEX IF NOT EXISTS idx_posts_post_id ON posts(post_id) WHERE post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_dirty ON posts(dirty) WHERE dirty = 1;
CREATE TABLE IF NOT EXISTS post_terms (
    local_id INTEGER NOT NULL REFERENCES posts(local_id) ON DELETE CASCADE,
    taxonomy TEXT NOT NULL,
    ref TEXT NOT NULL,
    PRIMARY KEY (local_id, taxonomy, ref)
);
`);

export function getSetting(key: string): string | null {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string | null } | undefined;
    return row?.value ?? null;
}

export function setSetting(key: string, value: string | null): void {
    db.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
}

export interface SettingsShape {
    siteUrl: string;
    username: string;
    appPassword: string;
    proxyUrl: string;
    defaultAuthorId: number | null;
    lastSyncCursor: string | null;
}

export function getSettings(): SettingsShape {
    return {
        siteUrl: getSetting("siteUrl") ?? "",
        username: getSetting("username") ?? "",
        appPassword: getSetting("appPassword") ?? "",
        proxyUrl: getSetting("proxyUrl") ?? "",
        defaultAuthorId: getSetting("defaultAuthorId") ? Number(getSetting("defaultAuthorId")) : null,
        lastSyncCursor: getSetting("lastSyncCursor"),
    };
}

export interface PostRow {
    localId: number;
    postId: number | null;
    status: string;
    title: string;
    content: string;
    authorId: number | null;
    dateLocal: string;
    dateGmt: string;
    modifiedGmt: string;
    fileserve: string | null;
    dirty: boolean;
    conflict: boolean;
    missing: boolean;
    lastSyncedGmt: string | null;
    lastPushedGmt: string | null;
    lastError: string | null;
    snapshot: string | null;
}

interface PostDbRow {
    local_id: number;
    post_id: number | null;
    status: string;
    title: string;
    content: string;
    author_id: number | null;
    date_local: string;
    date_gmt: string;
    modified_gmt: string;
    fileserve: string | null;
    dirty: number;
    conflict: number;
    missing: number;
    last_synced_gmt: string | null;
    last_pushed_gmt: string | null;
    last_error: string | null;
    snapshot: string | null;
}

function fromDb(row: PostDbRow): PostRow {
    return {
        localId: row.local_id,
        postId: row.post_id,
        status: row.status,
        title: row.title,
        content: row.content,
        authorId: row.author_id,
        dateLocal: row.date_local,
        dateGmt: row.date_gmt,
        modifiedGmt: row.modified_gmt,
        fileserve: row.fileserve,
        dirty: row.dirty === 1,
        conflict: row.conflict === 1,
        missing: row.missing === 1,
        lastSyncedGmt: row.last_synced_gmt,
        lastPushedGmt: row.last_pushed_gmt,
        lastError: row.last_error,
        snapshot: row.snapshot,
    };
}

const POST_FIELDS = `local_id, post_id, status, title, content, author_id, date_local, date_gmt,
    modified_gmt, fileserve, dirty, conflict, missing, last_synced_gmt, last_pushed_gmt, last_error, snapshot`;

export function listPosts(): PostRow[] {
    const rows = db.prepare(`SELECT ${POST_FIELDS} FROM posts ORDER BY local_id`).all() as PostDbRow[];
    return rows.map(fromDb);
}

export function listDirtyPosts(localIds?: number[]): PostRow[] {
    if (localIds && localIds.length > 0) {
        const placeholders = localIds.map(() => "?").join(",");
        const rows = db
            .prepare(
                `SELECT ${POST_FIELDS} FROM posts WHERE dirty = 1 AND local_id IN (${placeholders}) ORDER BY local_id`,
            )
            .all(...localIds) as PostDbRow[];
        return rows.map(fromDb);
    }
    const rows = db.prepare(`SELECT ${POST_FIELDS} FROM posts WHERE dirty = 1 ORDER BY local_id`).all() as PostDbRow[];
    return rows.map(fromDb);
}

export function getPost(localId: number): PostRow | undefined {
    const row = db.prepare(`SELECT ${POST_FIELDS} FROM posts WHERE local_id = ?`).get(localId) as
        | PostDbRow
        | undefined;
    return row ? fromDb(row) : undefined;
}

export function getPostByRemoteId(postId: number): PostRow | undefined {
    const row = db.prepare(`SELECT ${POST_FIELDS} FROM posts WHERE post_id = ?`).get(postId) as
        | PostDbRow
        | undefined;
    return row ? fromDb(row) : undefined;
}

/** Patch of editable columns for a post row; undefined keys stay untouched. */
export interface PostPatch {
    postId?: number | null;
    status?: string;
    title?: string;
    content?: string;
    authorId?: number | null;
    dateLocal?: string;
    dateGmt?: string;
    modifiedGmt?: string;
    fileserve?: string | null;
    dirty?: boolean;
    conflict?: boolean;
    missing?: boolean;
    lastSyncedGmt?: string | null;
    lastPushedGmt?: string | null;
    lastError?: string | null;
    snapshot?: string | null;
}

const COLUMN_OF: Record<string, string> = {
    postId: "post_id",
    status: "status",
    title: "title",
    content: "content",
    authorId: "author_id",
    dateLocal: "date_local",
    dateGmt: "date_gmt",
    modifiedGmt: "modified_gmt",
    fileserve: "fileserve",
    dirty: "dirty",
    conflict: "conflict",
    missing: "missing",
    lastSyncedGmt: "last_synced_gmt",
    lastPushedGmt: "last_pushed_gmt",
    lastError: "last_error",
    snapshot: "snapshot",
};

/** better-sqlite3 binds booleans as... nothing — it throws. Convert them. */
function toBind(value: unknown): unknown {
    if (value === undefined) {
        return null;
    }
    return typeof value === "boolean" ? (value ? 1 : 0) : value;
}

export function insertPost(patch: PostPatch): number {
    const entries = Object.entries(patch)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [COLUMN_OF[key] ?? key, toBind(value)] as const);
    const columns = entries.map(([column]) => column);
    const values = entries.map(([, value]) => value);
    const placeholders = entries.map(() => "?").join(", ");
    const result = db
        .prepare(`INSERT INTO posts (${columns.join(", ")}) VALUES (${placeholders})`)
        .run(...values);
    return Number(result.lastInsertRowid);
}

export function updatePostRow(localId: number, patch: PostPatch): void {
    const entries = Object.entries(patch)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [COLUMN_OF[key] ?? key, toBind(value)] as const);
    if (entries.length === 0) {
        return;
    }
    const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
    const values = entries.map(([, value]) => value);
    db.prepare(`UPDATE posts SET ${assignments} WHERE local_id = ?`).run(...values, localId);
}

export function deletePost(localId: number): void {
    db.prepare("DELETE FROM posts WHERE local_id = ?").run(localId);
}

/** Term references of one row: "81" = term id 81, "name:标签" = a term to create on push. */
export function getTermRefs(localId: number): Record<string, string[]> {
    const rows = db.prepare("SELECT taxonomy, ref FROM post_terms WHERE local_id = ?").all(localId) as {
        taxonomy: string;
        ref: string;
    }[];
    const terms: Record<string, string[]> = {};
    for (const row of rows) {
        (terms[row.taxonomy] ??= []).push(row.ref);
    }
    return terms;
}

export function setTermRefs(localId: number, terms: Record<string, string[]>): void {
    const replace = db.transaction((termMap: Record<string, string[]>) => {
        db.prepare("DELETE FROM post_terms WHERE local_id = ?").run(localId);
        const insert = db.prepare("INSERT INTO post_terms (local_id, taxonomy, ref) VALUES (?, ?, ?)");
        for (const [taxonomy, refs] of Object.entries(termMap)) {
            for (const ref of refs) {
                insert.run(localId, taxonomy, ref);
            }
        }
    });
    replace(terms);
}

export interface WpTaxonomyInfo {
    slug: string;
    hierarchical: boolean;
    terms: { id: number; name: string; slug: string; count: number }[];
}

export function replaceTerms(taxonomies: WpTaxonomyInfo[]): void {
    const replace = db.transaction((list: WpTaxonomyInfo[]) => {
        db.prepare("DELETE FROM terms").run();
        const insert = db.prepare("INSERT INTO terms (taxonomy, term_id, name, slug) VALUES (?, ?, ?, ?)");
        for (const taxonomy of list) {
            for (const term of taxonomy.terms) {
                insert.run(taxonomy.slug, term.id, term.name, term.slug);
            }
        }
    });
    replace(taxonomies);
}

export function listTerms(): { taxonomy: string; id: number; name: string; slug: string }[] {
    return db
        .prepare("SELECT taxonomy, term_id AS id, name, slug FROM terms ORDER BY taxonomy, name")
        .all() as { taxonomy: string; id: number; name: string; slug: string }[];
}

export function upsertAuthor(id: number, name: string): void {
    if (!Number.isInteger(id) || id <= 0) {
        return;
    }
    db.prepare(
        "INSERT INTO authors (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name",
    ).run(id, name);
}

export interface AuthorRow {
    id: number;
    name: string;
    remark: string;
}

export function listAuthors(): AuthorRow[] {
    return db.prepare("SELECT id, name, remark FROM authors ORDER BY name").all() as AuthorRow[];
}

/** What a row looked like when the server last confirmed it — the revert base and the conflict yardstick. */
export interface Snapshot {
    status: string;
    title: string;
    content: string;
    authorId: number | null;
    dateLocal: string;
    dateGmt: string;
    modifiedGmt: string;
    terms: Record<string, string[]>;
    fileserve: unknown;
}

export function snapshotFromRemote(item: import("./wp.js").WpItem, termRefs: Record<string, string[]>): Snapshot {
    return {
        status: item.status,
        title: item.title,
        content: item.content,
        authorId: item.authorId,
        dateLocal: item.date,
        dateGmt: item.dateGmt,
        modifiedGmt: item.modifiedGmt,
        terms: termRefs,
        fileserve: item.fileserve,
    };
}

export function parseSnapshot(raw: string | null): Snapshot | null {
    if (!raw) {
        return null;
    }
    try {
        return JSON.parse(raw) as Snapshot;
    } catch {
        return null;
    }
}

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
    slug TEXT,
    fileserve_pushed_digest TEXT,
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
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    level TEXT NOT NULL,
    scope TEXT NOT NULL,
    ref INTEGER,
    message TEXT NOT NULL
);
`);

// Databases from before the digest baseline / slug capture lack these
// columns; the guarded ALTERs are the whole migration.
const postColumns = (db.pragma("table_info(posts)") as { name: string }[]).map((column) => column.name);
if (!postColumns.includes("slug")) {
    db.exec("ALTER TABLE posts ADD COLUMN slug TEXT");
}
if (!postColumns.includes("fileserve_pushed_digest")) {
    db.exec("ALTER TABLE posts ADD COLUMN fileserve_pushed_digest TEXT");
}

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
    /** Root where local staging directories are created (纯本地辅助；网盘
     * lane 不读它); "" = unset. */
    workRoot: string;
}

export function getSettings(): SettingsShape {
    return {
        siteUrl: getSetting("siteUrl") ?? "",
        username: getSetting("username") ?? "",
        appPassword: getSetting("appPassword") ?? "",
        proxyUrl: getSetting("proxyUrl") ?? "",
        defaultAuthorId: getSetting("defaultAuthorId") ? Number(getSetting("defaultAuthorId")) : null,
        lastSyncCursor: getSetting("lastSyncCursor"),
        workRoot: getSetting("workRoot") ?? "",
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
    /** The permalink's last segment, captured from sync/push responses. */
    slug: string | null;
    /** Digest of the file list the site last confirmed — feeds the grid's
     * 文件未推 / pushed badges. */
    fileservePushedDigest: string | null;
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
    slug: string | null;
    fileserve_pushed_digest: string | null;
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
        slug: row.slug,
        fileservePushedDigest: row.fileserve_pushed_digest,
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
    modified_gmt, fileserve, slug, fileserve_pushed_digest, dirty, conflict, missing, last_synced_gmt, last_pushed_gmt, last_error, snapshot`;

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
    slug?: string | null;
    fileservePushedDigest?: string | null;
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
    slug: "slug",
    fileservePushedDigest: "fileserve_pushed_digest",
    dirty: "dirty",
    conflict: "conflict",
    missing: "missing",
    lastSyncedGmt: "last_synced_gmt",
    lastPushedGmt: "last_pushed_gmt",
    lastError: "last_error",
    snapshot: "snapshot",
};

/** better-sqlite3 binds booleans as... nothing — it throws. Convert them.
 * Objects and arrays get stringified as a last defense: a raw object binding
 * would throw deep inside the driver instead of at the call site. */
function toBind(value: unknown): unknown {
    if (value === undefined) {
        return null;
    }
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }
    if (value === null || typeof value === "number" || typeof value === "bigint" || typeof value === "string" || Buffer.isBuffer(value)) {
        return value;
    }
    return JSON.stringify(value);
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

/** The shape CSV import builds; every row lands dirty so it joins the push queue. */
export interface ImportedRow {
    status: string;
    title: string;
    content: string;
    authorId: number | null;
    dateLocal: string;
    termRefs: Record<string, string[]>;
}

/** All-or-nothing bulk create: one transaction writes every imported row (and its term refs). */
export function importPosts(rows: ImportedRow[]): number[] {
    const insertAll = db.transaction((list: ImportedRow[]): number[] => {
        const ids: number[] = [];
        for (const row of list) {
            const localId = insertPost({
                status: row.status,
                title: row.title,
                content: row.content,
                authorId: row.authorId,
                dateLocal: row.dateLocal,
                dirty: true,
                lastSyncedGmt: null,
            });
            if (Object.keys(row.termRefs).length > 0) {
                setTermRefs(localId, row.termRefs);
            }
            ids.push(localId);
        }
        return ids;
    });
    return insertAll(rows);
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

// --- 运行日志 -------------------------------------------------------------
// One rolling table for everything the tool does operationally (sync, push,
// completion, staging dirs, boot). The UI polls it incrementally by id, so
// AUTOINCREMENT is load-bearing: ids never rewind, even after a full clear.

export type LogLevel = "info" | "warn" | "error";

const LOG_LIMIT = 2000;

export function logEvent(level: LogLevel, scope: string, message: string, ref?: number): void {
    db.prepare("INSERT INTO logs (ts, level, scope, ref, message) VALUES (?, ?, ?, ?, ?)").run(
        new Date().toISOString(),
        level,
        scope,
        ref ?? null,
        message,
    );
    db.prepare("DELETE FROM logs WHERE id <= (SELECT MAX(id) FROM logs) - ?").run(LOG_LIMIT);
}

export interface LogRow {
    id: number;
    ts: string;
    level: string;
    scope: string;
    ref: number | null;
    message: string;
}

/** The newest entries past the client's cursor, ascending. */
export function listLogs(after: number, limit: number): LogRow[] {
    return db
        .prepare(
            "SELECT * FROM (SELECT id, ts, level, scope, ref, message FROM logs WHERE id > ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
        )
        .all(after, limit) as LogRow[];
}

export function clearLogs(): number {
    return Number(db.prepare("DELETE FROM logs").run().changes);
}

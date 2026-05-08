/**
 * SqliteVecMemoryStore — durable MemoryStore backend backed by SQLite +
 * Alex Garcia's `sqlite-vec` extension. The PRD-designated production
 * default; persists across process restarts and supports vector
 * similarity search alongside structured + recent paths.
 *
 * Schema (per PRD § 4.1):
 *   entries(rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE,
 *           key, value JSON, created_at, plus six nullable+indexed
 *           scope columns)
 *   entries_vec(rowid INTEGER, embedding float[<dim>]) — vec0 virtual
 *
 * Concurrency: better-sqlite3 is synchronous; SQLite WAL handles
 * multi-process safety on the same DB file. The async interface is
 * shape-only.
 *
 * Embedder DI: constructor takes `embed: (texts) => Promise<number[][]>`.
 * Production wires `createHttpEmbedderClient(...).embed`; tests use a
 * deterministic mock.
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import Database, { type Database as SqliteDatabase } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type {
  MemoryEntry,
  MemoryPutInput,
  MemoryQuery,
  MemoryQueryResult,
  MemoryScope,
  MemoryStore,
} from './store.ts';

/** Same shape as createHttpEmbedderClient.embed — production wiring is
 *  a one-line passthrough. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface SqliteVecMemoryStoreOptions {
  /** Path to the SQLite file. ":memory:" for transient in-process. The
   *  parent directory is created if missing. */
  dbPath: string;
  /** Vector dimension — locked to schema at first open. Must match
   *  what the embedder produces. Changing it requires a fresh DB. */
  vectorDim: number;
  /** Embedder function. Tests inject a mock; production wires
   *  createHttpEmbedderClient.embed from @ecruz165/context-loader-core. */
  embed: EmbedFn;
}

const SCOPE_KEYS: ReadonlyArray<keyof MemoryScope> = [
  'jobId',
  'productId',
  'userId',
  'sessionId',
  'organizationId',
  'topic',
] as const;

const SCOPE_COLUMNS = [
  'job_id',
  'product_id',
  'user_id',
  'session_id',
  'organization_id',
  'topic',
] as const;

export class SqliteVecMemoryStore implements MemoryStore {
  private readonly db: SqliteDatabase;
  private readonly vectorDim: number;
  private readonly embed: EmbedFn;
  private closed = false;

  /**
   * Open + initialize. Creates the DB file (if missing), loads the
   * sqlite-vec extension, runs idempotent schema migrations. Throws
   * if the extension can't load — production-default backend should
   * fail loudly rather than silently degrade.
   */
  static async open(opts: SqliteVecMemoryStoreOptions): Promise<SqliteVecMemoryStore> {
    if (opts.dbPath !== ':memory:') {
      const dir = dirname(opts.dbPath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
      }
    }
    const db = new Database(opts.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    try {
      sqliteVec.load(db);
    } catch (err) {
      db.close();
      throw new Error(
        `Failed to load sqlite-vec extension: ${(err as Error).message}. ` +
          `Ensure the platform-specific binary (sqlite-vec-${process.platform}-${process.arch}) is installed.`,
      );
    }

    const store = new SqliteVecMemoryStore(db, opts.vectorDim, opts.embed);
    store.runMigrations();
    return store;
  }

  private constructor(db: SqliteDatabase, vectorDim: number, embed: EmbedFn) {
    this.db = db;
    this.vectorDim = vectorDim;
    this.embed = embed;
  }

  /** Idempotent schema creation. Safe to run on every open. */
  private runMigrations(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS entries (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        job_id TEXT,
        product_id TEXT,
        user_id TEXT,
        session_id TEXT,
        organization_id TEXT,
        topic TEXT,
        has_embedding INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_entries_key ON entries(key);
      CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_entries_job_id ON entries(job_id) WHERE job_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_entries_product_id ON entries(product_id) WHERE product_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_entries_user_id ON entries(user_id) WHERE user_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_entries_session_id ON entries(session_id) WHERE session_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_entries_organization_id ON entries(organization_id) WHERE organization_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_entries_topic ON entries(topic) WHERE topic IS NOT NULL;`,
    );

    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS entries_vec USING vec0(
        embedding float[${this.vectorDim}]
      );`,
    );
  }

  async put(input: MemoryPutInput): Promise<MemoryEntry> {
    if (this.closed) throw new Error('store is closed');
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const createdAt = new Date().toISOString();
    const valueJson = JSON.stringify(input.value);
    const scope = input.scope ?? {};

    // Embed if the value is a non-empty string; non-string values are
    // still queryable via structured / recent, just not via similarity.
    let embedding: number[] | null = null;
    if (typeof input.value === 'string' && input.value.length > 0) {
      const vectors = await this.embed([input.value]);
      const v = vectors[0];
      if (!v) throw new Error('embedder returned no vector for value');
      if (v.length !== this.vectorDim) {
        throw new Error(`embedding dim mismatch: expected ${this.vectorDim}, got ${v.length}`);
      }
      embedding = v;
    }

    const insertEntry = this.db.prepare(
      `INSERT INTO entries
         (id, key, value, created_at, job_id, product_id, user_id, session_id, organization_id, topic, has_embedding)
       VALUES (@id, @key, @value, @created_at, @job_id, @product_id, @user_id, @session_id, @organization_id, @topic, @has_embedding)`,
    );

    // Wrap entry insert + vec insert in a transaction so failure
    // mid-way leaves the table consistent.
    this.db.transaction(() => {
      const r = insertEntry.run({
        id,
        key: input.key,
        value: valueJson,
        created_at: createdAt,
        job_id: scope.jobId ?? null,
        product_id: scope.productId ?? null,
        user_id: scope.userId ?? null,
        session_id: scope.sessionId ?? null,
        organization_id: scope.organizationId ?? null,
        topic: scope.topic ?? null,
        has_embedding: embedding ? 1 : 0,
      });
      // better-sqlite3 returns number | bigint. sqlite-vec's vec0
      // requires the rowid binding to be SQLite INTEGER, which means
      // the JS value must be a BigInt OR a Number with no fractional
      // bits. Forcing BigInt is the unambiguous path — better-sqlite3
      // binds BigInt as INTEGER reliably.
      const rowidBig =
        typeof r.lastInsertRowid === 'bigint' ? r.lastInsertRowid : BigInt(r.lastInsertRowid);

      if (embedding) {
        const insertVec = this.db.prepare(
          `INSERT INTO entries_vec (rowid, embedding) VALUES (?, ?)`,
        );
        // sqlite-vec accepts JSON-stringified array OR Float32 buffer.
        // JSON is the simpler interop path.
        insertVec.run(rowidBig, JSON.stringify(embedding));
      }
    })();

    return {
      id,
      createdAt,
      key: input.key,
      value: input.value,
      scope,
    };
  }

  async query(q: MemoryQuery): Promise<MemoryQueryResult> {
    if (this.closed) throw new Error('store is closed');

    if (q.kind === 'graph') {
      return {
        kind: 'unsupported',
        reason: 'graph queries require a graph-capable backend (Neo4j); not in v1',
      };
    }

    if (q.kind === 'structured') {
      const { sql, params } = this.buildStructuredQuery(q.key, q.scope);
      const rows = this.db.prepare(sql).all(...params) as DbEntryRow[];
      return { kind: 'ok', entries: rows.map(rowToEntry) };
    }

    if (q.kind === 'recent') {
      const limit = q.limit ?? 20;
      const { sql, params } = this.buildStructuredQuery(undefined, q.scope, limit);
      const rows = this.db.prepare(sql).all(...params) as DbEntryRow[];
      return { kind: 'ok', entries: rows.map(rowToEntry) };
    }

    if (q.kind === 'similarity') {
      const vectors = await this.embed([q.q]);
      const v = vectors[0];
      if (!v) throw new Error('embedder returned no vector for similarity query');
      if (v.length !== this.vectorDim) {
        throw new Error(
          `query embedding dim mismatch: expected ${this.vectorDim}, got ${v.length}`,
        );
      }
      const topK = q.topK ?? 10;

      // KNN: bind the query vector as JSON; sqlite-vec parses identically
      // to a Float32 buffer. Over-fetch (k * 4) so post-filtering by
      // scope still returns topK after pruning.
      const kFetch = Math.max(topK * 4, topK);
      const { whereClause, params: scopeParams } = scopeWhere(q.scope, 'e.');
      const baseSql = `SELECT e.id, e.key, e.value, e.created_at,
                e.job_id, e.product_id, e.user_id, e.session_id,
                e.organization_id, e.topic,
                v.distance
         FROM entries_vec v
         JOIN entries e ON e.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ?`;
      const finalSql =
        whereClause.length > 0
          ? `${baseSql} AND ${whereClause} ORDER BY v.distance LIMIT ?`
          : `${baseSql} ORDER BY v.distance LIMIT ?`;

      const rows = this.db
        .prepare(finalSql)
        .all(JSON.stringify(v), kFetch, ...scopeParams, topK) as DbEntryRow[];
      return { kind: 'ok', entries: rows.map(rowToEntry) };
    }

    return { kind: 'unsupported', reason: 'unknown query kind' };
  }

  async size(): Promise<number> {
    if (this.closed) return 0;
    const r = this.db.prepare(`SELECT count(*) AS c FROM entries`).get() as { c: number };
    return r.c;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** Build SQL + bound params for structured / recent queries. */
  private buildStructuredQuery(
    key: string | undefined,
    scope: MemoryScope | undefined,
    limit?: number,
  ): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const wheres: string[] = [];
    if (key !== undefined) {
      wheres.push(`key = ?`);
      params.push(key);
    }
    const { whereClause, params: scopeParams } = scopeWhere(scope);
    if (whereClause.length > 0) {
      wheres.push(whereClause);
      params.push(...scopeParams);
    }
    let sql = `SELECT id, key, value, created_at,
              job_id, product_id, user_id, session_id,
              organization_id, topic
       FROM entries`;
    if (wheres.length > 0) {
      sql += ` WHERE ${wheres.join(' AND ')}`;
    }
    sql += ` ORDER BY created_at DESC`;
    if (limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }
    return { sql, params };
  }
}

interface DbEntryRow {
  id: string;
  key: string;
  value: string;
  created_at: string;
  job_id: string | null;
  product_id: string | null;
  user_id: string | null;
  session_id: string | null;
  organization_id: string | null;
  topic: string | null;
  distance?: number;
}

function rowToEntry(row: DbEntryRow): MemoryEntry {
  const scope: MemoryScope = {};
  if (row.job_id) scope.jobId = row.job_id;
  if (row.product_id) scope.productId = row.product_id;
  if (row.user_id) scope.userId = row.user_id;
  if (row.session_id) scope.sessionId = row.session_id;
  if (row.organization_id) scope.organizationId = row.organization_id;
  if (row.topic) scope.topic = row.topic;
  return {
    id: row.id,
    createdAt: row.created_at,
    key: row.key,
    value: JSON.parse(row.value),
    scope,
  };
}

function scopeWhere(
  scope: MemoryScope | undefined,
  prefix = '',
): { whereClause: string; params: unknown[] } {
  if (!scope) return { whereClause: '', params: [] };
  const wheres: string[] = [];
  const params: unknown[] = [];
  for (let i = 0; i < SCOPE_KEYS.length; i++) {
    const key = SCOPE_KEYS[i]!;
    const col = SCOPE_COLUMNS[i]!;
    const val = scope[key];
    if (val !== undefined) {
      wheres.push(`${prefix}${col} = ?`);
      params.push(val);
    }
  }
  return { whereClause: wheres.join(' AND '), params };
}

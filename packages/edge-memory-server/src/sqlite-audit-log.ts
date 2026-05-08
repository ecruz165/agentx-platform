/**
 * SQLite-backed AuditLog for production. Separate file by default
 * from the memory store — different retention policies, different
 * GDPR carve-outs (memory entries can be `forget`-ten by user
 * request; audit log is append-only forensics that survives that).
 *
 * Same scope-as-columns approach as the memory store schema for
 * consistency. JSON-serialized entryIds keep the row count flat for
 * bulk operations (one event row even when 1000 entries deleted).
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import Database, { type Database as SqliteDatabase } from 'better-sqlite3';
import type { AuditEvent, AuditLog, AuditLogQuery } from './audit.ts';
import type { MemoryScope } from './store.ts';

export interface SqliteAuditLogOptions {
  /** Path to the SQLite file. ":memory:" for transient in-process. */
  dbPath: string;
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

export class SqliteAuditLog implements AuditLog {
  private readonly db: SqliteDatabase;
  private closed = false;

  static async open(opts: SqliteAuditLogOptions): Promise<SqliteAuditLog> {
    if (opts.dbPath !== ':memory:') {
      const dir = dirname(opts.dbPath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
      }
    }
    const db = new Database(opts.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const log = new SqliteAuditLog(db);
    log.runMigrations();
    return log;
  }

  private constructor(db: SqliteDatabase) {
    this.db = db;
  }

  private runMigrations(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS audit_events (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        timestamp TEXT NOT NULL,
        op TEXT NOT NULL,
        actor TEXT NOT NULL,
        count INTEGER NOT NULL,
        entry_ids_json TEXT NOT NULL,
        job_id TEXT,
        product_id TEXT,
        user_id TEXT,
        session_id TEXT,
        organization_id TEXT,
        topic TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_op ON audit_events(op);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor);
      CREATE INDEX IF NOT EXISTS idx_audit_job_id ON audit_events(job_id) WHERE job_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_audit_product_id ON audit_events(product_id) WHERE product_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_events(user_id) WHERE user_id IS NOT NULL;`,
    );
  }

  async append(event: Omit<AuditEvent, 'id' | 'timestamp'>): Promise<AuditEvent> {
    if (this.closed) throw new Error('audit log is closed');
    const persisted: AuditEvent = {
      id: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      timestamp: new Date().toISOString(),
      ...event,
    };
    const scope = persisted.scope ?? {};
    this.db
      .prepare(
        `INSERT INTO audit_events
          (id, timestamp, op, actor, count, entry_ids_json,
           job_id, product_id, user_id, session_id, organization_id, topic)
         VALUES (@id, @timestamp, @op, @actor, @count, @entry_ids_json,
                 @job_id, @product_id, @user_id, @session_id, @organization_id, @topic)`,
      )
      .run({
        id: persisted.id,
        timestamp: persisted.timestamp,
        op: persisted.op,
        actor: persisted.actor,
        count: persisted.count,
        entry_ids_json: JSON.stringify(persisted.entryIds),
        job_id: scope.jobId ?? null,
        product_id: scope.productId ?? null,
        user_id: scope.userId ?? null,
        session_id: scope.sessionId ?? null,
        organization_id: scope.organizationId ?? null,
        topic: scope.topic ?? null,
      });
    return persisted;
  }

  async query(filter: AuditLogQuery = {}): Promise<AuditEvent[]> {
    if (this.closed) return [];
    const wheres: string[] = [];
    const params: unknown[] = [];
    if (filter.since !== undefined) {
      wheres.push(`timestamp >= ?`);
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      wheres.push(`timestamp < ?`);
      params.push(filter.until);
    }
    if (filter.op !== undefined) {
      wheres.push(`op = ?`);
      params.push(filter.op);
    }
    if (filter.actor !== undefined) {
      wheres.push(`actor = ?`);
      params.push(filter.actor);
    }
    if (filter.scope !== undefined) {
      for (let i = 0; i < SCOPE_KEYS.length; i++) {
        const key = SCOPE_KEYS[i]!;
        const col = SCOPE_COLUMNS[i]!;
        const val = filter.scope[key];
        if (val !== undefined) {
          wheres.push(`${col} = ?`);
          params.push(val);
        }
      }
    }
    const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    const limit = filter.limit ?? 100;
    const rows = this.db
      .prepare(
        `SELECT id, timestamp, op, actor, count, entry_ids_json,
                job_id, product_id, user_id, session_id, organization_id, topic
         FROM audit_events
         ${whereSql}
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(...params, limit) as AuditEventRow[];
    return rows.map(rowToAuditEvent);
  }

  async size(): Promise<number> {
    if (this.closed) return 0;
    const r = this.db.prepare(`SELECT count(*) AS c FROM audit_events`).get() as { c: number };
    return r.c;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

interface AuditEventRow {
  id: string;
  timestamp: string;
  op: AuditEvent['op'];
  actor: string;
  count: number;
  entry_ids_json: string;
  job_id: string | null;
  product_id: string | null;
  user_id: string | null;
  session_id: string | null;
  organization_id: string | null;
  topic: string | null;
}

function rowToAuditEvent(row: AuditEventRow): AuditEvent {
  const scope: MemoryScope = {};
  if (row.job_id) scope.jobId = row.job_id;
  if (row.product_id) scope.productId = row.product_id;
  if (row.user_id) scope.userId = row.user_id;
  if (row.session_id) scope.sessionId = row.session_id;
  if (row.organization_id) scope.organizationId = row.organization_id;
  if (row.topic) scope.topic = row.topic;
  return {
    id: row.id,
    timestamp: row.timestamp,
    op: row.op,
    actor: row.actor,
    count: row.count,
    entryIds: JSON.parse(row.entry_ids_json) as string[],
    scope: Object.keys(scope).length > 0 ? scope : undefined,
  };
}

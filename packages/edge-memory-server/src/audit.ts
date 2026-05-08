/**
 * Audit log — append-only record of every memory write + delete, per
 * PRD F12. Sibling concern to `MemoryStore` (storage); kept separate
 * so retention, GDPR, and storage policies can differ from the
 * underlying data.
 *
 * Schema (per PRD § 4.1):
 *   { id, timestamp, op, scope?, entryIds[], actor, count }
 *
 * Bulk operations (forget, import) write ONE event with `entryIds`
 * populated and `count` set — not N events for N entries. Keeps the
 * audit log compact and avoids N-rows-per-op blow-up on large imports.
 *
 * Actor (PRD F33): `uds:<uid>` for local UDS. v1 ships `uds:local`
 * as a placeholder; v1.x adds real UID extraction (Linux SO_PEERCRED,
 * macOS LOCAL_PEERCRED). The field shape is correct so the upgrade
 * is additive.
 *
 * Storage:
 *   - InMemoryAuditLog — Map-based, tests + dev
 *   - SqliteAuditLog — separate SQLite file by default, production
 *
 * Two separate concerns:
 *   1. Capture (append a typed event when something happens)
 *   2. Query (filter by scope, op, actor, time range)
 *
 * The CLI surfaces both via `edge-memory audit` (read-only forensics).
 */

import type { MemoryScope } from './store.ts';

/** One audit-loggable operation. */
export type AuditOp = 'put' | 'forget' | 'import';

/**
 * One row in the audit log. Server-assigned `id` is monotonic-ish
 * within a single process (not globally unique across restarts —
 * use `timestamp` + `id` as the dedup tuple if you need that).
 */
export interface AuditEvent {
  id: string;
  /** ISO 8601 — second of the operation, server-side wall clock. */
  timestamp: string;
  /** What kind of operation triggered this event. */
  op: AuditOp;
  /** Scope dimension(s) the operation acted in/on. For put: the
   *  entry's scope. For forget: the predicate's scope (which entries
   *  were targeted). For import: undefined (each line may have its
   *  own scope; aggregating across lines is misleading). */
  scope?: MemoryScope;
  /** Entry ids affected. For put: [<new-id>]. For forget: ids of
   *  entries deleted (sample-capped to match MemoryForgetResult).
   *  For import: ids of newly-created entries (capped at 100 to
   *  avoid runaway audit rows on large imports — `count` is
   *  authoritative). */
  entryIds: string[];
  /** Number of entries the operation actually touched. Authoritative
   *  even when `entryIds` is sample-capped. */
  count: number;
  /** Connection source — `uds:<uid>` per PRD F33. v1 stores
   *  `uds:local` as a placeholder; v1.x will fill in the real uid. */
  actor: string;
}

export interface AuditLogQuery {
  /** Earliest event timestamp (inclusive). ISO 8601. */
  since?: string;
  /** Latest event timestamp (exclusive). ISO 8601. */
  until?: string;
  /** Filter by op type. */
  op?: AuditOp;
  /** Subset-match on scope — same semantics as MemoryQuery scope filter. */
  scope?: MemoryScope;
  /** Filter by actor. */
  actor?: string;
  /** Cap result size (default 100). */
  limit?: number;
}

export interface AuditLog {
  /** Persist a new event. Server assigns id + timestamp; caller
   *  supplies everything else. Returns the persisted event with
   *  populated id/timestamp. */
  append(event: Omit<AuditEvent, 'id' | 'timestamp'>): Promise<AuditEvent>;
  /** Filtered query. Newest first. Empty filter → last `limit`
   *  events. */
  query(filter?: AuditLogQuery): Promise<AuditEvent[]>;
  /** Total row count. Useful for /health diagnostics. */
  size(): Promise<number>;
}

/** Default actor placeholder when caller didn't supply one. v1.x
 *  upgrades when real UID extraction lands; for now any callers using
 *  the default emit a uniform `uds:local` so query filtering still
 *  works. */
export const DEFAULT_ACTOR = 'uds:local';

// ─── InMemoryAuditLog ─────────────────────────────────────────────────────

/**
 * In-memory implementation. Tests + dev. No persistence; server
 * restart wipes the log. Production should use `SqliteAuditLog`.
 */
export class InMemoryAuditLog implements AuditLog {
  private readonly events: AuditEvent[] = [];
  private nextId = 1;

  async append(event: Omit<AuditEvent, 'id' | 'timestamp'>): Promise<AuditEvent> {
    const persisted: AuditEvent = {
      id: `aud_${this.nextId++}`,
      timestamp: new Date().toISOString(),
      ...event,
    };
    this.events.push(persisted);
    return persisted;
  }

  async query(filter: AuditLogQuery = {}): Promise<AuditEvent[]> {
    const limit = filter.limit ?? 100;
    const filtered = this.events.filter((e) => matchesAuditFilter(e, filter));
    // Newest first.
    filtered.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    return filtered.slice(0, limit);
  }

  async size(): Promise<number> {
    return this.events.length;
  }
}

/**
 * Predicate match for audit query. Set fields AND-combine; unset
 * fields are wildcards. Exported for symmetry with the SQLite impl
 * (which mirrors this in SQL).
 */
export function matchesAuditFilter(event: AuditEvent, filter: AuditLogQuery): boolean {
  if (filter.since !== undefined && event.timestamp < filter.since) return false;
  if (filter.until !== undefined && event.timestamp >= filter.until) return false;
  if (filter.op !== undefined && event.op !== filter.op) return false;
  if (filter.actor !== undefined && event.actor !== filter.actor) return false;
  if (filter.scope !== undefined) {
    const eventScope = event.scope ?? {};
    for (const key of Object.keys(filter.scope) as Array<keyof MemoryScope>) {
      const filterValue = filter.scope[key];
      if (filterValue === undefined) continue;
      if (eventScope[key] !== filterValue) return false;
    }
  }
  return true;
}

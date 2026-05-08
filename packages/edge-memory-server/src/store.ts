/**
 * MemoryStore — backend interface for the edge-memory-server.
 *
 * The server's REST routes are storage-agnostic; per-backend behavior
 * (in-memory for tests/dev, sqlite-vec for production v1, Neo4j /
 * pgvector / Chroma in v1.x+) implements this interface. v1-lite ships
 * `InMemoryMemoryStore` only — the foundational contract; sqlite-vec
 * lands when similarity-search becomes a real product need.
 *
 * v1-lite supports `structured` (exact-match key/value retrieval) and
 * `recent` (last-N entries by scope) queries. `similarity` (vector
 * embedding-based) and `graph` (cross-entry relationships) are
 * defined-but-unsupported in this slice; backends return
 * `{ kind: 'unsupported' }` so the CLI surfaces a clear message
 * rather than a silent empty result.
 *
 * Scope keys (per PRD F3): jobId, productId, userId, sessionId,
 * organizationId, topic. Entries carry an optional set of these as
 * tags; queries filter by intersection. v1-lite treats all six the
 * same — no precedence chain or write-narrowest-by-default yet.
 * Those land when the consolidation lifecycle (F14-F19) does.
 */

/** A persisted memory entry. The `id` is generated server-side; `createdAt`
 *  is wall-clock time of the put. `value` is opaque JSON the agent owns. */
export interface MemoryEntry {
  id: string;
  createdAt: string;
  /** Opaque key the writer assigns; queries can filter by exact match. */
  key: string;
  /** Opaque payload — string, number, object, anything serializable. */
  value: unknown;
  /** Per-PRD F3 scope dimensions. Any subset may be set; entries without
   *  scope are global. */
  scope: MemoryScope;
}

/** Scope tags. All optional. */
export interface MemoryScope {
  jobId?: string;
  productId?: string;
  userId?: string;
  sessionId?: string;
  organizationId?: string;
  topic?: string;
}

/** Caller-supplied content for a put — backend assigns id + createdAt. */
export interface MemoryPutInput {
  key: string;
  value: unknown;
  scope?: MemoryScope;
}

/** Discriminated union of query shapes (PRD F4). */
export type MemoryQuery =
  | { kind: 'structured'; key?: string; scope?: MemoryScope }
  | { kind: 'recent'; scope?: MemoryScope; limit?: number }
  | { kind: 'similarity'; q: string; scope?: MemoryScope; topK?: number }
  | { kind: 'graph'; from: string; depth?: number };

export type MemoryQueryResult =
  | { kind: 'ok'; entries: MemoryEntry[] }
  | { kind: 'unsupported'; reason: string };

export interface MemoryStore {
  put(input: MemoryPutInput): Promise<MemoryEntry>;
  query(q: MemoryQuery): Promise<MemoryQueryResult>;
  /** Diagnostic count — total entries across all scopes. Used for /health. */
  size(): Promise<number>;
}

// ─── InMemoryMemoryStore ──────────────────────────────────────────────────

/**
 * In-memory backend. Map-based, no persistence. Used by tests + dev
 * bringup; production swaps in sqlite-vec.
 *
 * Concurrency: the entire surface is async-by-shape but synchronous-in-
 * implementation (Map operations are single-threaded in JS). A future
 * sqlite-vec backend will make the async-ness real; the interface
 * already accommodates.
 */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private nextId = 1;

  async put(input: MemoryPutInput): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: `mem_${this.nextId++}`,
      createdAt: new Date().toISOString(),
      key: input.key,
      value: input.value,
      scope: input.scope ?? {},
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  async query(q: MemoryQuery): Promise<MemoryQueryResult> {
    if (q.kind === 'similarity') {
      return {
        kind: 'unsupported',
        reason: 'similarity queries require a vector-capable backend (sqlite-vec); not in v1-lite',
      };
    }
    if (q.kind === 'graph') {
      return {
        kind: 'unsupported',
        reason: 'graph queries require a graph-capable backend (Neo4j); not in v1-lite',
      };
    }

    const all = [...this.entries.values()];

    if (q.kind === 'structured') {
      const filtered = all.filter((e) => {
        if (q.key !== undefined && e.key !== q.key) return false;
        return scopeMatches(e.scope, q.scope);
      });
      // Newest first by default — reviewers expect to see latest writes.
      filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return { kind: 'ok', entries: filtered };
    }

    if (q.kind === 'recent') {
      const filtered = all.filter((e) => scopeMatches(e.scope, q.scope));
      filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const limit = q.limit ?? 20;
      return { kind: 'ok', entries: filtered.slice(0, limit) };
    }

    // Exhaustiveness — impossible at runtime given the discriminated union.
    return { kind: 'unsupported', reason: `unknown query kind` };
  }

  async size(): Promise<number> {
    return this.entries.size;
  }
}

/**
 * Subset-match: every key set on the filter must equal the corresponding
 * key on the entry. Filter keys absent / undefined are wildcards.
 *
 * Empty filter (or no filter at all) matches every entry.
 */
function scopeMatches(entryScope: MemoryScope, filter: MemoryScope | undefined): boolean {
  if (!filter) return true;
  for (const key of Object.keys(filter) as Array<keyof MemoryScope>) {
    const filterValue = filter[key];
    if (filterValue === undefined) continue;
    if (entryScope[key] !== filterValue) return false;
  }
  return true;
}

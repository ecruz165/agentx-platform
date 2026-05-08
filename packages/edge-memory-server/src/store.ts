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
  /** Per PRD F16: every entry carries a provenance record so consolidation
   *  + feedback flows have something to AND-filter against. New writes
   *  default to `feedback: 'unconfirmed'`; tag/consolidate transitions
   *  it to positive/negative. */
  provenance: MemoryProvenance;
}

/** PRD F16. Default-state for new entries: feedback='unconfirmed',
 *  originatingJobId/originatingProductId mirrored from scope, no
 *  consolidation lineage. */
export interface MemoryProvenance {
  /** Job that wrote this entry (mirrored from scope.jobId at put time). */
  originatingJobId?: string;
  /** Product the writing job ran against (mirrored from scope.productId). */
  originatingProductId?: string;
  /** If this entry came from consolidation (F14), which entries fed it. */
  consolidatedFrom?: { scope: MemoryScope; entryIds: string[] };
  /** Strategy that produced this entry: 'rule' (verbatim promote),
   *  'summary' (LLM-distilled), 'manual' (admin lift-and-shift). Unset
   *  on direct writes (not a consolidation result). */
  consolidatedBy?: 'rule' | 'summary' | 'manual';
  /** ISO timestamp of the consolidation that produced this entry. */
  consolidatedAt?: string;
  /** Feedback label. `unconfirmed` until tagged; tag/consolidate
   *  flow transitions it. */
  feedback: 'positive' | 'negative' | 'unconfirmed';
  /** What event tagged this entry. Carried through consolidation. */
  feedbackSource?: FeedbackSource;
  /** ISO timestamp of the most recent feedback transition. */
  feedbackAt?: string;
}

export type FeedbackSource =
  | 'hitl-approval'
  | 'hitl-rejection'
  | 'phase-success'
  | 'phase-failure'
  | 'pr-merged'
  | 'pr-rejected'
  | 'tests-passed'
  | 'tests-failed'
  | 'rollback'
  | 'manual'
  | 'agent-self-eval';

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
  /** Optional override of the default provenance. Most callers should
   *  not set this; consolidation and import are the legitimate uses. */
  provenance?: MemoryProvenance;
}

/** Build the default provenance for a fresh write — feedback unconfirmed,
 *  no consolidation lineage, originating IDs mirrored from scope. */
export function defaultProvenance(scope: MemoryScope | undefined): MemoryProvenance {
  return {
    feedback: 'unconfirmed',
    ...(scope?.jobId !== undefined ? { originatingJobId: scope.jobId } : {}),
    ...(scope?.productId !== undefined ? { originatingProductId: scope.productId } : {}),
  };
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

/**
 * Predicate for `forget`. AND-combined: an entry must match every set
 * field to be deleted. At least one field MUST be set — empty
 * predicates are rejected so `forget({})` never wipes the entire store
 * by accident. Per PRD F6 (GDPR-compliant predicate-based delete).
 *
 *   - scope: subset-match (same semantics as query scope filter)
 *   - key: exact match
 *   - olderThan: ISO timestamp; entries created strictly before this
 *     are eligible. Useful for "clean up everything before date X."
 */
export interface MemoryForgetPredicate {
  scope?: MemoryScope;
  key?: string;
  olderThan?: string;
  /** Exact-id match. Used by consolidation's source-cleanup pass to
   *  delete just the entries it promoted (not all matching key+scope,
   *  which would catch unconfirmed siblings — F19's job, not F14's). */
  id?: string;
  /** Filter by feedback label. Used by F19 cleanup-unconfirmed: pass
   *  feedback='unconfirmed' + scope to prune residual unlabeled entries
   *  at job-end. */
  feedback?: 'unconfirmed' | 'positive' | 'negative';
}

export interface MemoryForgetResult {
  deleted: number;
  /** Audit-friendly: ids of removed entries, in deletion order. Capped
   *  at 100 to avoid runaway responses on bulk deletes. The `deleted`
   *  count is authoritative; this is just for log reconciliation. */
  deletedIds: string[];
}

/**
 * PRD F18 input shape. Either `entryIds` or any of the predicate fields
 * (scope, key, olderThan) must be set; mixing is allowed (intersection).
 *
 * `feedback` is required — caller must positively assert what label to
 * apply. There is no default. Tagging is a deliberate signal, not a
 * sweep operation.
 *
 * `overwrite: false` (default) skips entries already tagged
 * positive/negative — the alreadyTagged count surfaces them. `true`
 * re-tags with the new label (audited by the new feedbackAt timestamp).
 */
export interface MemoryTagInput {
  entryIds?: string[];
  scope?: MemoryScope;
  key?: string;
  olderThan?: string;
  feedback: 'positive' | 'negative';
  feedbackSource?: FeedbackSource;
  overwrite?: boolean;
}

export interface MemoryTagResult {
  tagged: number;
  /** Entries that already had a positive/negative tag and were skipped
   *  (only when overwrite=false). */
  alreadyTagged: number;
  /** Sample of newly-tagged entry ids, capped at 100 for audit. */
  taggedIds: string[];
}

/** Reject empty tag input — no implicit "tag everything" mode. */
export function assertNonEmptyTagInput(t: MemoryTagInput): void {
  const hasIds = Array.isArray(t.entryIds) && t.entryIds.length > 0;
  const scopeHasField =
    t.scope !== undefined && Object.values(t.scope).some((v) => v !== undefined);
  if (!hasIds && !scopeHasField && t.key === undefined && t.olderThan === undefined) {
    throw new Error(
      'tag input must set at least one of: entryIds, key, olderThan, or scope (with at least one scope key)',
    );
  }
}

export interface MemoryStore {
  put(input: MemoryPutInput): Promise<MemoryEntry>;
  query(q: MemoryQuery): Promise<MemoryQueryResult>;
  /** GDPR delete. Throws on empty predicate; otherwise removes all
   *  entries matching ALL set fields and returns a count + sample ids. */
  forget(predicate: MemoryForgetPredicate): Promise<MemoryForgetResult>;
  /** Diagnostic count — total entries across all scopes. Used for /health. */
  size(): Promise<number>;
  /** PRD F18: feedback-tag entries. Updates provenance.feedback +
   *  feedbackSource + feedbackAt on every match. Throws on empty
   *  input via assertNonEmptyTagInput. */
  tag(input: MemoryTagInput): Promise<MemoryTagResult>;
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
      provenance: input.provenance ?? defaultProvenance(input.scope),
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  /** Test-only access: list all entries (read-only snapshot). Used by
   *  tag/consolidate flows that need to scan + mutate. */
  _entries(): IterableIterator<MemoryEntry> {
    return this.entries.values();
  }

  /** Test-only mutation: replace an entry's provenance. The tag + */
  /** consolidate flows use this; declared on the implementation rather */
  /** than the interface so backends can override with native ops. */
  _setProvenance(id: string, p: MemoryProvenance): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    this.entries.set(id, { ...e, provenance: p });
    return true;
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

  async forget(predicate: MemoryForgetPredicate): Promise<MemoryForgetResult> {
    assertNonEmptyForgetPredicate(predicate);
    const deletedIds: string[] = [];
    let deleted = 0;
    for (const [id, entry] of this.entries) {
      if (matchesForgetPredicate(entry, predicate)) {
        this.entries.delete(id);
        deleted++;
        // Sample first 100 ids for audit trail; the count is the
        // authoritative number.
        if (deletedIds.length < 100) deletedIds.push(id);
      }
    }
    return { deleted, deletedIds };
  }

  async tag(input: MemoryTagInput): Promise<MemoryTagResult> {
    assertNonEmptyTagInput(input);
    const idSet = input.entryIds ? new Set(input.entryIds) : null;
    const overwrite = input.overwrite === true;
    const feedbackAt = new Date().toISOString();
    let tagged = 0;
    let alreadyTagged = 0;
    const taggedIds: string[] = [];

    for (const [id, entry] of this.entries) {
      // Match: entry must satisfy idSet (if set) AND every set
      // predicate field. Mirrors forget's AND semantics.
      if (idSet && !idSet.has(id)) continue;
      if (input.key !== undefined && entry.key !== input.key) continue;
      if (input.olderThan !== undefined && entry.createdAt >= input.olderThan) continue;
      if (input.scope !== undefined && !scopeMatches(entry.scope, input.scope)) continue;

      const current = entry.provenance.feedback;
      if (!overwrite && current !== 'unconfirmed') {
        alreadyTagged++;
        continue;
      }
      this.entries.set(id, {
        ...entry,
        provenance: {
          ...entry.provenance,
          feedback: input.feedback,
          ...(input.feedbackSource !== undefined ? { feedbackSource: input.feedbackSource } : {}),
          feedbackAt,
        },
      });
      tagged++;
      if (taggedIds.length < 100) taggedIds.push(id);
    }
    return { tagged, alreadyTagged, taggedIds };
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

/**
 * Reject empty `forget` predicates so `forget({})` never wipes the
 * entire store by accident. At least one of `scope`, `key`, or
 * `olderThan` must be set; for `scope` to count, it must itself have
 * at least one defined key.
 *
 * Exported so server-side validation can call it directly + return a
 * 400 before touching the store.
 */
export function assertNonEmptyForgetPredicate(p: MemoryForgetPredicate): void {
  const scopeHasField =
    p.scope !== undefined && Object.values(p.scope).some((v) => v !== undefined);
  if (
    !scopeHasField &&
    p.key === undefined &&
    p.olderThan === undefined &&
    p.id === undefined &&
    p.feedback === undefined
  ) {
    throw new Error(
      'forget predicate must set at least one of: key, olderThan, id, feedback, or scope (with at least one scope key)',
    );
  }
}

/**
 * AND-match for forget. An entry is eligible iff every set field of
 * the predicate matches.
 *
 * Exported for the SqliteVecMemoryStore tests (which exercise their
 * SQL implementation but cross-check against this reference).
 */
export function matchesForgetPredicate(entry: MemoryEntry, p: MemoryForgetPredicate): boolean {
  if (p.scope !== undefined && !scopeMatches(entry.scope, p.scope)) return false;
  if (p.key !== undefined && entry.key !== p.key) return false;
  if (p.olderThan !== undefined && entry.createdAt >= p.olderThan) return false;
  if (p.id !== undefined && entry.id !== p.id) return false;
  if (p.feedback !== undefined && entry.provenance.feedback !== p.feedback) return false;
  return true;
}

/**
 * Inspect (PRD F37) — diagnostic surface that aggregates store
 * contents into scope-summary + feedback-status breakdowns. Composes
 * the existing query interface; no new SQL needed.
 *
 * The output is "what's in this scope, broken down for humans" —
 * counts per feedback label, counts per scope-key value, optionally
 * the consolidatedFrom lineage of every entry.
 *
 * Cap considerations: per PRD §5 the store sizes at ≤1M entries. A
 * full-store inspect is acceptable to scan in JS at that volume; we
 * pull via kind:'recent' with a huge limit. For multi-million v1.x
 * deployments, swap in a SQL GROUP BY implementation per backend.
 */

import type { MemoryEntry, MemoryScope, MemoryStore } from './store.ts';

export interface InspectInput {
  /** Optional scope filter — only inspect entries that match. Empty
   *  filter = global summary. */
  scope?: MemoryScope;
  /** When true, include per-entry consolidatedFrom + feedback timeline
   *  in the response. Default false (the summary alone is what humans
   *  usually want). */
  showLineage?: boolean;
}

export interface InspectScopeBreakdown {
  jobIds: Record<string, number>;
  productIds: Record<string, number>;
  userIds: Record<string, number>;
  sessionIds: Record<string, number>;
  organizationIds: Record<string, number>;
  topics: Record<string, number>;
}

export interface InspectLineageEntry {
  id: string;
  key: string;
  scope: MemoryScope;
  feedback: 'positive' | 'negative' | 'unconfirmed';
  feedbackSource?: string;
  feedbackAt?: string;
  consolidatedBy?: string;
  consolidatedAt?: string;
  consolidatedFromScope?: MemoryScope;
  consolidatedFromIds?: string[];
}

export interface InspectResult {
  totalEntries: number;
  byFeedback: { positive: number; negative: number; unconfirmed: number };
  byScope: InspectScopeBreakdown;
  /** Only present when showLineage=true. Up to 1000 entries
   *  (cap to keep response payload bounded). */
  lineage?: InspectLineageEntry[];
}

export async function inspect(input: InspectInput, store: MemoryStore): Promise<InspectResult> {
  const result: InspectResult = {
    totalEntries: 0,
    byFeedback: { positive: 0, negative: 0, unconfirmed: 0 },
    byScope: {
      jobIds: {},
      productIds: {},
      userIds: {},
      sessionIds: {},
      organizationIds: {},
      topics: {},
    },
  };

  const q = await store.query({
    kind: 'recent',
    ...(input.scope ? { scope: input.scope } : {}),
    limit: 1_000_000,
  });
  if (q.kind !== 'ok') return result;

  const lineage: InspectLineageEntry[] = [];
  for (const entry of q.entries) {
    result.totalEntries++;
    result.byFeedback[entry.provenance.feedback]++;
    incrementScope(result.byScope, entry);
    if (input.showLineage && lineage.length < 1000) {
      lineage.push(toLineageEntry(entry));
    }
  }
  if (input.showLineage) result.lineage = lineage;
  return result;
}

function incrementScope(b: InspectScopeBreakdown, entry: MemoryEntry): void {
  if (entry.scope.jobId) b.jobIds[entry.scope.jobId] = (b.jobIds[entry.scope.jobId] ?? 0) + 1;
  if (entry.scope.productId)
    b.productIds[entry.scope.productId] = (b.productIds[entry.scope.productId] ?? 0) + 1;
  if (entry.scope.userId) b.userIds[entry.scope.userId] = (b.userIds[entry.scope.userId] ?? 0) + 1;
  if (entry.scope.sessionId)
    b.sessionIds[entry.scope.sessionId] = (b.sessionIds[entry.scope.sessionId] ?? 0) + 1;
  if (entry.scope.organizationId)
    b.organizationIds[entry.scope.organizationId] =
      (b.organizationIds[entry.scope.organizationId] ?? 0) + 1;
  if (entry.scope.topic) b.topics[entry.scope.topic] = (b.topics[entry.scope.topic] ?? 0) + 1;
}

function toLineageEntry(entry: MemoryEntry): InspectLineageEntry {
  const out: InspectLineageEntry = {
    id: entry.id,
    key: entry.key,
    scope: entry.scope,
    feedback: entry.provenance.feedback,
  };
  if (entry.provenance.feedbackSource) out.feedbackSource = entry.provenance.feedbackSource;
  if (entry.provenance.feedbackAt) out.feedbackAt = entry.provenance.feedbackAt;
  if (entry.provenance.consolidatedBy) out.consolidatedBy = entry.provenance.consolidatedBy;
  if (entry.provenance.consolidatedAt) out.consolidatedAt = entry.provenance.consolidatedAt;
  if (entry.provenance.consolidatedFrom) {
    out.consolidatedFromScope = entry.provenance.consolidatedFrom.scope;
    out.consolidatedFromIds = entry.provenance.consolidatedFrom.entryIds;
  }
  return out;
}

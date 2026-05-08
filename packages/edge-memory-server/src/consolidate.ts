/**
 * Memory consolidation (PRD F14/F15) — promote feedback-tagged entries
 * from a narrow scope (e.g., jobId) to a wider scope (e.g., productId
 * or userId).
 *
 * Pure orchestration on top of MemoryStore — no SQL, no transport.
 * Composes query + put + (optionally) forget. Tested in isolation
 * against InMemoryMemoryStore; the same code drives SqliteVecMemoryStore
 * via the same interface.
 *
 * Strategies (PRD F15):
 *   - feedback-required (default): only entries tagged
 *     positive|negative are eligible; promotes verbatim with feedback
 *     label preserved
 *   - feedback-by-topic: feedback-required + topic filter (only entries
 *     in `topic` are promoted)
 *   - feedback-summarize: LLM-driven; groups eligible entries by
 *     feedback label, calls `summarize()` per group, writes ONE
 *     summary entry per non-empty group (success-pattern +
 *     anti-pattern). Pluggable via the `summarize` callback.
 *   - include-all: bypasses the feedback gate, promotes everything in
 *     `from` scope including unconfirmed entries. Emits a warning
 *     because this defeats the "writes are working notes; only labeled
 *     stuff persists" invariant from PRD § 4.1.5.
 *
 * Defaults: feedbackFilter = ['positive', 'negative']. Empty filter is
 * a config error (would silently consolidate nothing OR everything,
 * depending on strategy interpretation — neither is what the caller
 * meant).
 */

import type { AuditLog } from './audit.ts';
import { resolveActor } from './audit.ts';
import type { MemoryEntry, MemoryScope, MemoryStore } from './store.ts';

export type ConsolidateStrategy =
  | 'feedback-required'
  | 'feedback-by-topic'
  | 'feedback-summarize'
  | 'include-all';

export interface ConsolidateInput {
  from: { scope: MemoryScope };
  to: { scope: MemoryScope };
  strategy?: ConsolidateStrategy;
  /** Subset of {'positive','negative'}. Default both. Empty is rejected. */
  feedbackFilter?: Array<'positive' | 'negative'>;
  /** Only used by `feedback-by-topic`; required for that strategy. */
  topic?: string;
  /** When true, source entries remain after promotion. Default false:
   *  consolidate is a move, not a copy (the wider-scope entry replaces
   *  the narrow one). Set to true if the caller wants both. */
  keepSource?: boolean;
}

export interface ConsolidateResult {
  /** Count of entries written at `to` scope. */
  promoted: number;
  /** Eligible-but-skipped count (e.g., feedback didn't match filter). */
  skipped: number;
  /** Number of source entries that fed `feedback-summarize` strategy.
   *  undefined for non-summarize strategies. */
  summarizedFrom?: number;
  /** Sample of newly-created entry ids at `to` scope (capped at 100). */
  lineageIds: string[];
  /** Breakdown of promoted entries by feedback label. */
  feedbackBreakdown: { positive: number; negative: number };
}

/** Pluggable LLM summarizer for `feedback-summarize` strategy. v1 ships
 *  a fallback that concatenates entry values; production injects a real
 *  LLM client (e.g., Anthropic Messages API). */
export type SummarizeFn = (
  feedback: 'positive' | 'negative',
  entries: MemoryEntry[],
) => Promise<{ key: string; value: unknown }>;

/** Default summarizer — concatenation. Documented as a placeholder so
 *  callers know to inject a real LLM client. */
export const defaultSummarize: SummarizeFn = async (feedback, entries) => ({
  key: feedback === 'positive' ? 'success-pattern' : 'anti-pattern',
  value: {
    summary: `${entries.length} ${feedback} entries (default summarizer; inject SummarizeFn for LLM distillation)`,
    sources: entries.slice(0, 5).map((e) => ({ id: e.id, key: e.key, value: e.value })),
  },
});

export interface ConsolidateOptions {
  /** Custom summarizer for `feedback-summarize` strategy. Default:
   *  defaultSummarize (concatenation placeholder; v1.x ships an LLM
   *  client integration via this hook). */
  summarize?: SummarizeFn;
  /** Logger for include-all warnings + summarize errors. */
  warn?: (msg: string) => void;
}

export async function consolidate(
  input: ConsolidateInput,
  store: MemoryStore,
  audit: AuditLog,
  opts: ConsolidateOptions = {},
): Promise<ConsolidateResult> {
  validateInput(input);
  const strategy = input.strategy ?? 'feedback-required';
  const feedbackFilter = input.feedbackFilter ?? ['positive', 'negative'];
  const summarize = opts.summarize ?? defaultSummarize;
  const warn = opts.warn ?? ((m) => console.warn(`[consolidate] ${m}`));

  // Pull every entry from the source scope. We use kind:'recent' with a
  // huge limit because that's the cheapest path that returns all
  // matching entries newest-first; structured-with-no-key works too.
  const sourceQ = await store.query({ kind: 'recent', scope: input.from.scope, limit: 100_000 });
  if (sourceQ.kind !== 'ok') {
    throw new Error(`source scope query unsupported: ${sourceQ.reason}`);
  }
  const sourceEntries = sourceQ.entries;

  // Filter by strategy.
  const eligible: MemoryEntry[] = [];
  let skipped = 0;
  for (const entry of sourceEntries) {
    if (strategy === 'include-all') {
      eligible.push(entry);
      continue;
    }
    const f = entry.provenance.feedback;
    if (f === 'unconfirmed' || !feedbackFilter.includes(f)) {
      skipped++;
      continue;
    }
    if (strategy === 'feedback-by-topic') {
      if (input.topic === undefined) {
        throw new Error('strategy=feedback-by-topic requires `topic` field');
      }
      if (entry.scope.topic !== input.topic) {
        skipped++;
        continue;
      }
    }
    eligible.push(entry);
  }

  if (strategy === 'include-all') {
    warn(
      'strategy=include-all bypasses feedback gating — promotes ALL source entries (PRD § 4.1.5)',
    );
  }

  const result: ConsolidateResult = {
    promoted: 0,
    skipped,
    lineageIds: [],
    feedbackBreakdown: { positive: 0, negative: 0 },
  };

  const consolidatedAt = new Date().toISOString();
  const consolidatedBy = strategy === 'feedback-summarize' ? 'summary' : 'rule';

  if (strategy === 'feedback-summarize') {
    // Group eligible entries by feedback label, call summarize() per
    // non-empty group, write ONE summary entry per group.
    const positive = eligible.filter((e) => e.provenance.feedback === 'positive');
    const negative = eligible.filter((e) => e.provenance.feedback === 'negative');
    result.summarizedFrom = positive.length + negative.length;

    for (const [feedback, group] of [
      ['positive', positive] as const,
      ['negative', negative] as const,
    ]) {
      if (group.length === 0) continue;
      const { key, value } = await summarize(feedback, group);
      const entry = await store.put({
        key,
        value,
        scope: input.to.scope,
        provenance: {
          feedback,
          consolidatedBy: 'summary',
          consolidatedAt,
          consolidatedFrom: { scope: input.from.scope, entryIds: group.map((e) => e.id) },
        },
      });
      result.promoted++;
      if (result.lineageIds.length < 100) result.lineageIds.push(entry.id);
      result.feedbackBreakdown[feedback]++;
    }
  } else {
    // feedback-required, feedback-by-topic, include-all all do verbatim
    // promotes — same code path.
    for (const src of eligible) {
      const newEntry = await store.put({
        key: src.key,
        value: src.value,
        scope: input.to.scope,
        provenance: {
          feedback: src.provenance.feedback,
          ...(src.provenance.feedbackSource !== undefined
            ? { feedbackSource: src.provenance.feedbackSource }
            : {}),
          ...(src.provenance.feedbackAt !== undefined
            ? { feedbackAt: src.provenance.feedbackAt }
            : {}),
          consolidatedBy,
          consolidatedAt,
          consolidatedFrom: { scope: input.from.scope, entryIds: [src.id] },
        },
      });
      result.promoted++;
      if (result.lineageIds.length < 100) result.lineageIds.push(newEntry.id);
      if (src.provenance.feedback === 'positive') result.feedbackBreakdown.positive++;
      else if (src.provenance.feedback === 'negative') result.feedbackBreakdown.negative++;
    }
  }

  // PRD F14: keepSource defaults to false — consolidate is a move.
  if (!input.keepSource && eligible.length > 0) {
    // Forget exactly the eligible source entries by their ids isn't
    // a forget shape; we forget by the source scope. The post-condition
    // is "source scope is empty after consolidate" for the verbatim
    // strategies. For include-all that's literal; for feedback-required
    // we leave unconfirmed source entries behind (cleanup-unconfirmed
    // F19 handles those).
    if (strategy === 'include-all') {
      await store.forget({ scope: input.from.scope });
    } else {
      // Delete EXACTLY the eligible source entries by id. Don't forget
      // by key+scope — that catches unconfirmed siblings (which are
      // F19's domain, not F14's). The id-based forget predicate
      // landed alongside this slice for exactly this reason.
      for (const src of eligible) {
        await store.forget({ id: src.id });
      }
    }
  }

  if (result.promoted > 0) {
    await audit.append({
      op: 'consolidate',
      actor: resolveActor(),
      count: result.promoted,
      entryIds: result.lineageIds,
      scope: input.to.scope,
    });
  }

  return result;
}

function validateInput(input: ConsolidateInput): void {
  if (!input.from || !isMeaningfulScope(input.from.scope)) {
    throw new Error('consolidate requires `from.scope` with at least one set scope key');
  }
  if (!input.to || !isMeaningfulScope(input.to.scope)) {
    throw new Error('consolidate requires `to.scope` with at least one set scope key');
  }
  if (Array.isArray(input.feedbackFilter) && input.feedbackFilter.length === 0) {
    throw new Error(
      'feedbackFilter cannot be empty — set ["positive","negative"] (default) or omit',
    );
  }
}

function isMeaningfulScope(s: MemoryScope | undefined): boolean {
  if (!s) return false;
  return Object.values(s).some((v) => v !== undefined);
}

/**
 * Unit tests for the consolidate orchestration. Pure tests against
 * InMemoryMemoryStore + InMemoryAuditLog; the SQL backend follows the
 * same MemoryStore interface so coverage transfers.
 */

import { describe, expect, it, vi } from 'vitest';
import { InMemoryAuditLog } from './audit.ts';
import { consolidate, type SummarizeFn } from './consolidate.ts';
import { InMemoryMemoryStore } from './store.ts';

async function seedJobScope(store: InMemoryMemoryStore) {
  // Three positives, two negatives, one unconfirmed — all in jobId:j1.
  const ids: Record<string, string> = {};
  ids.p1 = (await store.put({ key: 'plan', value: 'A', scope: { jobId: 'j1' } })).id;
  ids.p2 = (await store.put({ key: 'plan', value: 'B', scope: { jobId: 'j1' } })).id;
  ids.p3 = (await store.put({ key: 'note', value: 'C', scope: { jobId: 'j1' } })).id;
  ids.n1 = (await store.put({ key: 'plan', value: 'D', scope: { jobId: 'j1' } })).id;
  ids.n2 = (await store.put({ key: 'note', value: 'E', scope: { jobId: 'j1' } })).id;
  ids.u1 = (await store.put({ key: 'plan', value: 'U', scope: { jobId: 'j1' } })).id;

  await store.tag({ entryIds: [ids.p1, ids.p2, ids.p3], feedback: 'positive' });
  await store.tag({ entryIds: [ids.n1, ids.n2], feedback: 'negative' });
  return ids;
}

describe('consolidate — input validation', () => {
  it('rejects missing or empty from/to scopes', async () => {
    const store = new InMemoryMemoryStore();
    const audit = new InMemoryAuditLog();
    await expect(
      consolidate({ from: { scope: {} }, to: { scope: { productId: 'web' } } }, store, audit),
    ).rejects.toThrow(/from\.scope/);
    await expect(
      consolidate({ from: { scope: { jobId: 'j1' } }, to: { scope: {} } }, store, audit),
    ).rejects.toThrow(/to\.scope/);
  });

  it('rejects empty feedbackFilter array', async () => {
    const store = new InMemoryMemoryStore();
    const audit = new InMemoryAuditLog();
    await expect(
      consolidate(
        {
          from: { scope: { jobId: 'j1' } },
          to: { scope: { productId: 'web' } },
          feedbackFilter: [],
        },
        store,
        audit,
      ),
    ).rejects.toThrow(/feedbackFilter cannot be empty/);
  });
});

describe('consolidate — feedback-required (default)', () => {
  it('promotes only positive+negative; unconfirmed stays at source', async () => {
    const store = new InMemoryMemoryStore();
    const audit = new InMemoryAuditLog();
    await seedJobScope(store);

    const r = await consolidate(
      { from: { scope: { jobId: 'j1' } }, to: { scope: { productId: 'web' } } },
      store,
      audit,
    );
    expect(r.promoted).toBe(5); // 3 pos + 2 neg
    expect(r.feedbackBreakdown).toEqual({ positive: 3, negative: 2 });
    expect(r.skipped).toBe(1); // the unconfirmed one
  });

  it('promoted entries land at to.scope with consolidatedFrom lineage', async () => {
    const store = new InMemoryMemoryStore();
    const audit = new InMemoryAuditLog();
    await seedJobScope(store);

    await consolidate(
      { from: { scope: { jobId: 'j1' } }, to: { scope: { productId: 'web' } }, keepSource: true },
      store,
      audit,
    );

    const promoted = await store.query({ kind: 'recent', scope: { productId: 'web' } });
    if (promoted.kind !== 'ok') throw new Error('expected ok');
    expect(promoted.entries).toHaveLength(5);
    for (const e of promoted.entries) {
      expect(e.scope.productId).toBe('web');
      expect(e.provenance.consolidatedBy).toBe('rule');
      expect(e.provenance.consolidatedFrom?.scope).toEqual({ jobId: 'j1' });
      expect(e.provenance.consolidatedFrom?.entryIds).toHaveLength(1);
    }
  });

  it('keepSource=false (default) deletes promoted source entries; unconfirmed stays', async () => {
    const store = new InMemoryMemoryStore();
    const audit = new InMemoryAuditLog();
    await seedJobScope(store);

    await consolidate(
      { from: { scope: { jobId: 'j1' } }, to: { scope: { productId: 'web' } } },
      store,
      audit,
    );

    const remaining = await store.query({ kind: 'recent', scope: { jobId: 'j1' } });
    if (remaining.kind !== 'ok') throw new Error('expected ok');
    // Only the unconfirmed one should remain.
    expect(remaining.entries).toHaveLength(1);
    expect(remaining.entries[0]?.provenance.feedback).toBe('unconfirmed');
  });

  it('feedbackFilter=["positive"] only promotes positive', async () => {
    const store = new InMemoryMemoryStore();
    const audit = new InMemoryAuditLog();
    await seedJobScope(store);
    const r = await consolidate(
      {
        from: { scope: { jobId: 'j1' } },
        to: { scope: { productId: 'web' } },
        feedbackFilter: ['positive'],
        keepSource: true,
      },
      store,
      audit,
    );
    expect(r.promoted).toBe(3);
    expect(r.feedbackBreakdown).toEqual({ positive: 3, negative: 0 });
  });

  it('audit logs one consolidate event with promoted count', async () => {
    const store = new InMemoryMemoryStore();
    const audit = new InMemoryAuditLog();
    await seedJobScope(store);

    await consolidate(
      { from: { scope: { jobId: 'j1' } }, to: { scope: { productId: 'web' } } },
      store,
      audit,
    );
    const events = await audit.query({ op: 'consolidate' });
    expect(events).toHaveLength(1);
    expect(events[0]?.count).toBe(5);
    expect(events[0]?.scope).toEqual({ productId: 'web' });
  });
});

describe('consolidate — feedback-by-topic', () => {
  it('only promotes entries matching the topic filter', async () => {
    const store = new InMemoryMemoryStore();
    const audit = new InMemoryAuditLog();
    await store.put({ key: 'a', value: 'A', scope: { jobId: 'j1', topic: 'plan' } });
    await store.put({ key: 'b', value: 'B', scope: { jobId: 'j1', topic: 'plan' } });
    await store.put({ key: 'c', value: 'C', scope: { jobId: 'j1', topic: 'review' } });
    await store.tag({ scope: { jobId: 'j1' }, feedback: 'positive' });

    const r = await consolidate(
      {
        from: { scope: { jobId: 'j1' } },
        to: { scope: { productId: 'web' } },
        strategy: 'feedback-by-topic',
        topic: 'plan',
        keepSource: true,
      },
      store,
      audit,
    );
    expect(r.promoted).toBe(2);
    expect(r.skipped).toBe(1);
  });

  it('rejects feedback-by-topic without `topic`', async () => {
    const store = new InMemoryMemoryStore();
    const audit = new InMemoryAuditLog();
    await store.put({ key: 'a', value: 'A', scope: { jobId: 'j1' } });
    await store.tag({ scope: { jobId: 'j1' }, feedback: 'positive' });
    await expect(
      consolidate(
        {
          from: { scope: { jobId: 'j1' } },
          to: { scope: { productId: 'web' } },
          strategy: 'feedback-by-topic',
        },
        store,
        audit,
      ),
    ).rejects.toThrow(/topic/);
  });
});

describe('consolidate — feedback-summarize', () => {
  it('produces ONE entry per non-empty feedback group; consolidatedBy=summary', async () => {
    const store = new InMemoryMemoryStore();
    const audit = new InMemoryAuditLog();
    await seedJobScope(store);

    const summarize: SummarizeFn = vi.fn(async (feedback, entries) => ({
      key: feedback === 'positive' ? 'success-pattern' : 'anti-pattern',
      value: { summary: `summary of ${entries.length} ${feedback}` },
    }));

    const r = await consolidate(
      {
        from: { scope: { jobId: 'j1' } },
        to: { scope: { productId: 'web' } },
        strategy: 'feedback-summarize',
        keepSource: true,
      },
      store,
      audit,
      { summarize },
    );
    expect(r.promoted).toBe(2); // one positive summary + one negative summary
    expect(r.summarizedFrom).toBe(5);
    expect(summarize).toHaveBeenCalledTimes(2);

    const promoted = await store.query({ kind: 'recent', scope: { productId: 'web' } });
    if (promoted.kind !== 'ok') throw new Error('expected ok');
    const keys = promoted.entries.map((e) => e.key).sort();
    expect(keys).toEqual(['anti-pattern', 'success-pattern']);
    for (const e of promoted.entries) {
      expect(e.provenance.consolidatedBy).toBe('summary');
      expect(e.provenance.consolidatedFrom?.entryIds.length).toBeGreaterThan(0);
    }
  });

  it('skips groups with no eligible entries (only positive feedback present)', async () => {
    const store = new InMemoryMemoryStore();
    const audit = new InMemoryAuditLog();
    await store.put({ key: 'a', value: 'A', scope: { jobId: 'j1' } });
    await store.tag({ scope: { jobId: 'j1' }, feedback: 'positive' });

    const r = await consolidate(
      {
        from: { scope: { jobId: 'j1' } },
        to: { scope: { productId: 'web' } },
        strategy: 'feedback-summarize',
        keepSource: true,
      },
      store,
      audit,
    );
    expect(r.promoted).toBe(1); // success-pattern only
    expect(r.feedbackBreakdown).toEqual({ positive: 1, negative: 0 });
  });
});

describe('consolidate — include-all', () => {
  it('promotes everything in source scope including unconfirmed; warns', async () => {
    const store = new InMemoryMemoryStore();
    const audit = new InMemoryAuditLog();
    await seedJobScope(store);
    const warns: string[] = [];

    const r = await consolidate(
      {
        from: { scope: { jobId: 'j1' } },
        to: { scope: { productId: 'web' } },
        strategy: 'include-all',
        keepSource: true,
      },
      store,
      audit,
      { warn: (m) => warns.push(m) },
    );
    expect(r.promoted).toBe(6);
    expect(warns.some((w) => /bypasses feedback gating/.test(w))).toBe(true);
  });

  it('keepSource=false on include-all wipes the source scope', async () => {
    const store = new InMemoryMemoryStore();
    const audit = new InMemoryAuditLog();
    await seedJobScope(store);

    await consolidate(
      {
        from: { scope: { jobId: 'j1' } },
        to: { scope: { productId: 'web' } },
        strategy: 'include-all',
      },
      store,
      audit,
    );
    const remaining = await store.query({ kind: 'recent', scope: { jobId: 'j1' } });
    if (remaining.kind !== 'ok') throw new Error('expected ok');
    expect(remaining.entries).toHaveLength(0);
  });
});

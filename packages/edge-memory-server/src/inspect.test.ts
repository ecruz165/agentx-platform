import { describe, expect, it } from 'vitest';
import { inspect } from './inspect.ts';
import { InMemoryMemoryStore } from './store.ts';

describe('inspect', () => {
  it('returns zero counts on empty store', async () => {
    const store = new InMemoryMemoryStore();
    const r = await inspect({}, store);
    expect(r.totalEntries).toBe(0);
    expect(r.byFeedback).toEqual({ positive: 0, negative: 0, unconfirmed: 0 });
  });

  it('aggregates byFeedback + byScope across all entries', async () => {
    const store = new InMemoryMemoryStore();
    await store.put({ key: 'a', value: 'A', scope: { jobId: 'j1', productId: 'web' } });
    await store.put({ key: 'b', value: 'B', scope: { jobId: 'j1', productId: 'web' } });
    await store.put({ key: 'c', value: 'C', scope: { jobId: 'j2', productId: 'api' } });
    await store.tag({ key: 'a', feedback: 'positive' });
    await store.tag({ key: 'b', feedback: 'negative' });

    const r = await inspect({}, store);
    expect(r.totalEntries).toBe(3);
    expect(r.byFeedback).toEqual({ positive: 1, negative: 1, unconfirmed: 1 });
    expect(r.byScope.jobIds).toEqual({ j1: 2, j2: 1 });
    expect(r.byScope.productIds).toEqual({ web: 2, api: 1 });
  });

  it('honors scope filter — only counts matching entries', async () => {
    const store = new InMemoryMemoryStore();
    await store.put({ key: 'a', value: 'A', scope: { jobId: 'j1' } });
    await store.put({ key: 'b', value: 'B', scope: { jobId: 'j2' } });

    const r = await inspect({ scope: { jobId: 'j1' } }, store);
    expect(r.totalEntries).toBe(1);
    expect(r.byScope.jobIds).toEqual({ j1: 1 });
  });

  it('showLineage=false (default) omits per-entry lineage', async () => {
    const store = new InMemoryMemoryStore();
    await store.put({ key: 'a', value: 'A' });
    const r = await inspect({}, store);
    expect(r.lineage).toBeUndefined();
  });

  it('showLineage=true returns per-entry breakdown including consolidatedFrom', async () => {
    const store = new InMemoryMemoryStore();
    await store.put({
      key: 'success-pattern',
      value: { summary: 'x' },
      scope: { productId: 'web' },
      provenance: {
        feedback: 'positive',
        consolidatedBy: 'rule',
        consolidatedAt: '2026-05-08T00:00:00.000Z',
        consolidatedFrom: { scope: { jobId: 'j1' }, entryIds: ['mem_a', 'mem_b'] },
      },
    });
    const r = await inspect({ showLineage: true }, store);
    expect(r.lineage).toHaveLength(1);
    expect(r.lineage?.[0]?.consolidatedBy).toBe('rule');
    expect(r.lineage?.[0]?.consolidatedFromScope).toEqual({ jobId: 'j1' });
    expect(r.lineage?.[0]?.consolidatedFromIds).toEqual(['mem_a', 'mem_b']);
  });
});

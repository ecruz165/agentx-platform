/**
 * Unit tests for MemoryStore (InMemoryMemoryStore implementation).
 * Pure tests — no HTTP, no UDS, just the in-memory backend's behavior.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryMemoryStore, type MemoryStore } from './store.ts';

describe('InMemoryMemoryStore — put + query (structured)', () => {
  it('stores an entry and returns it via structured query by key', async () => {
    const store: MemoryStore = new InMemoryMemoryStore();
    await store.put({ key: 'plan', value: 'use OAuth' });

    const result = await store.query({ kind: 'structured', key: 'plan' });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.key).toBe('plan');
    expect(result.entries[0]?.value).toBe('use OAuth');
    expect(result.entries[0]?.id).toMatch(/^mem_\d+$/);
    expect(result.entries[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('assigns sequential ids', async () => {
    const store = new InMemoryMemoryStore();
    const a = await store.put({ key: 'a', value: 1 });
    const b = await store.put({ key: 'b', value: 2 });
    expect(a.id).toBe('mem_1');
    expect(b.id).toBe('mem_2');
  });

  it('filters by scope on query — only matching entries returned', async () => {
    const store = new InMemoryMemoryStore();
    await store.put({ key: 'k', value: 'A', scope: { productId: 'web' } });
    await store.put({ key: 'k', value: 'B', scope: { productId: 'api' } });
    await store.put({ key: 'k', value: 'C' }); // no scope (global)

    const webOnly = await store.query({
      kind: 'structured',
      key: 'k',
      scope: { productId: 'web' },
    });
    if (webOnly.kind !== 'ok') throw new Error('expected ok');
    expect(webOnly.entries.map((e) => e.value)).toEqual(['A']);

    // No-scope query matches all (subset semantics: empty filter = wildcard).
    const all = await store.query({ kind: 'structured', key: 'k' });
    if (all.kind !== 'ok') throw new Error('expected ok');
    expect(all.entries.map((e) => e.value).sort()).toEqual(['A', 'B', 'C']);
  });

  it('multiple scope keys are AND-combined', async () => {
    const store = new InMemoryMemoryStore();
    await store.put({ key: 'k', value: 1, scope: { productId: 'web', userId: 'alice' } });
    await store.put({ key: 'k', value: 2, scope: { productId: 'web', userId: 'bob' } });
    await store.put({ key: 'k', value: 3, scope: { productId: 'api', userId: 'alice' } });

    const result = await store.query({
      kind: 'structured',
      key: 'k',
      scope: { productId: 'web', userId: 'alice' },
    });
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.value).toBe(1);
  });

  it('returns newest-first in structured query', async () => {
    const store = new InMemoryMemoryStore();
    await store.put({ key: 'k', value: 'first' });
    // Tiny delay so ISO timestamps differ.
    await new Promise((r) => setTimeout(r, 5));
    await store.put({ key: 'k', value: 'second' });

    const result = await store.query({ kind: 'structured', key: 'k' });
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.entries.map((e) => e.value)).toEqual(['second', 'first']);
  });
});

describe('InMemoryMemoryStore — query (recent)', () => {
  it('returns the last N entries newest-first across scope', async () => {
    const store = new InMemoryMemoryStore();
    for (let i = 1; i <= 5; i++) {
      await store.put({ key: `k${i}`, value: i });
      await new Promise((r) => setTimeout(r, 2));
    }
    const result = await store.query({ kind: 'recent', limit: 3 });
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.entries.map((e) => e.value)).toEqual([5, 4, 3]);
  });

  it('respects scope filter on recent', async () => {
    const store = new InMemoryMemoryStore();
    await store.put({ key: 'a', value: 1, scope: { productId: 'web' } });
    await store.put({ key: 'b', value: 2, scope: { productId: 'api' } });
    await store.put({ key: 'c', value: 3, scope: { productId: 'web' } });
    const result = await store.query({
      kind: 'recent',
      scope: { productId: 'web' },
    });
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.entries.map((e) => e.value).sort()).toEqual([1, 3]);
  });

  it('default limit is 20', async () => {
    const store = new InMemoryMemoryStore();
    for (let i = 0; i < 25; i++) {
      await store.put({ key: 'k', value: i });
    }
    const result = await store.query({ kind: 'recent' });
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.entries).toHaveLength(20);
  });
});

describe('InMemoryMemoryStore — unsupported queries', () => {
  it('returns unsupported for similarity in v1-lite', async () => {
    const store = new InMemoryMemoryStore();
    const result = await store.query({ kind: 'similarity', q: 'anything' });
    expect(result.kind).toBe('unsupported');
    if (result.kind !== 'unsupported') return;
    expect(result.reason).toMatch(/sqlite-vec/);
  });

  it('returns unsupported for graph queries in v1-lite', async () => {
    const store = new InMemoryMemoryStore();
    const result = await store.query({ kind: 'graph', from: 'mem_1' });
    expect(result.kind).toBe('unsupported');
    if (result.kind !== 'unsupported') return;
    expect(result.reason).toMatch(/Neo4j/);
  });
});

describe('InMemoryMemoryStore — size', () => {
  it('reports the entry count', async () => {
    const store = new InMemoryMemoryStore();
    expect(await store.size()).toBe(0);
    await store.put({ key: 'a', value: 1 });
    await store.put({ key: 'b', value: 2 });
    expect(await store.size()).toBe(2);
  });
});

describe('InMemoryMemoryStore — forget', () => {
  it('rejects empty predicate (safety against accidental wipe)', async () => {
    const store = new InMemoryMemoryStore();
    await store.put({ key: 'a', value: 1 });
    await expect(store.forget({})).rejects.toThrow(/at least one of/);
    await expect(store.forget({ scope: {} })).rejects.toThrow(/at least one of/);
    expect(await store.size()).toBe(1);
  });

  it('deletes by key', async () => {
    const store = new InMemoryMemoryStore();
    await store.put({ key: 'plan', value: 'A' });
    await store.put({ key: 'plan', value: 'B' });
    await store.put({ key: 'other', value: 'C' });

    const r = await store.forget({ key: 'plan' });
    expect(r.deleted).toBe(2);
    expect(r.deletedIds).toHaveLength(2);
    expect(await store.size()).toBe(1);

    const remaining = await store.query({ kind: 'structured' });
    if (remaining.kind !== 'ok') throw new Error('expected ok');
    expect(remaining.entries.map((e) => e.value)).toEqual(['C']);
  });

  it('deletes by scope (subset match — AND-combined when multiple keys set)', async () => {
    const store = new InMemoryMemoryStore();
    await store.put({ key: 'k', value: 1, scope: { productId: 'web', userId: 'alice' } });
    await store.put({ key: 'k', value: 2, scope: { productId: 'web', userId: 'bob' } });
    await store.put({ key: 'k', value: 3, scope: { productId: 'api', userId: 'alice' } });

    const r = await store.forget({ scope: { productId: 'web' } });
    expect(r.deleted).toBe(2);
    expect(await store.size()).toBe(1);

    const remaining = await store.query({ kind: 'structured' });
    if (remaining.kind !== 'ok') throw new Error('expected ok');
    expect(remaining.entries.map((e) => e.value)).toEqual([3]);
  });

  it('deletes by olderThan (entries strictly before timestamp)', async () => {
    const store = new InMemoryMemoryStore();
    await store.put({ key: 'a', value: 'old' });
    await new Promise((r) => setTimeout(r, 5));
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    await store.put({ key: 'b', value: 'new' });

    const r = await store.forget({ olderThan: cutoff });
    expect(r.deleted).toBe(1);

    const remaining = await store.query({ kind: 'structured' });
    if (remaining.kind !== 'ok') throw new Error('expected ok');
    expect(remaining.entries.map((e) => e.value)).toEqual(['new']);
  });

  it('combines predicate fields with AND', async () => {
    const store = new InMemoryMemoryStore();
    await store.put({ key: 'plan', value: 1, scope: { productId: 'web' } });
    await store.put({ key: 'plan', value: 2, scope: { productId: 'api' } });
    await store.put({ key: 'other', value: 3, scope: { productId: 'web' } });

    // Only entries that match BOTH key='plan' AND productId='web' are deleted.
    const r = await store.forget({ key: 'plan', scope: { productId: 'web' } });
    expect(r.deleted).toBe(1);

    const remaining = await store.query({ kind: 'structured' });
    if (remaining.kind !== 'ok') throw new Error('expected ok');
    expect(remaining.entries.map((e) => e.value).sort()).toEqual([2, 3]);
  });

  it('returns deleted=0 when nothing matches (no error)', async () => {
    const store = new InMemoryMemoryStore();
    await store.put({ key: 'a', value: 1 });
    const r = await store.forget({ key: 'nonexistent' });
    expect(r.deleted).toBe(0);
    expect(r.deletedIds).toEqual([]);
    expect(await store.size()).toBe(1);
  });

  it('caps deletedIds sample at 100 (count is authoritative)', async () => {
    const store = new InMemoryMemoryStore();
    for (let i = 0; i < 150; i++) {
      await store.put({ key: 'bulk', value: i });
    }
    const r = await store.forget({ key: 'bulk' });
    expect(r.deleted).toBe(150);
    expect(r.deletedIds.length).toBe(100); // sample capped
    expect(await store.size()).toBe(0);
  });
});

/**
 * Integration tests for SqliteVecMemoryStore. Real better-sqlite3 + real
 * sqlite-vec extension; no live LLM (the embedder is a deterministic
 * mock — given a known string, returns a known vector).
 *
 * Coverage:
 *   - schema migration is idempotent (open + reopen on same file)
 *   - put + structured/recent queries (parity with InMemoryMemoryStore)
 *   - scope filtering at SQL level
 *   - similarity: KNN ranks the closest vector first
 *   - non-string values skip embedding gracefully (still queryable
 *     via structured/recent; absent from similarity)
 *   - persistence across close/reopen
 *   - dim mismatch errors loudly
 */

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type EmbedFn,
  SqliteVecMemoryStore,
  type SqliteVecMemoryStoreOptions,
} from './sqlite-vec-store.ts';

const tmpDb = () => join(tmpdir(), `mem-${randomUUID().slice(0, 8)}.sqlite`);

/**
 * Deterministic mock embedder. Given a text, returns a vector where each
 * dim is a hash of (text, dim_index). Same text → same vector across
 * calls; different texts → different vectors. NOT semantically meaningful;
 * just enough for KNN to behave deterministically.
 *
 * For "ranks closest first" tests we add a hook so the test can plant
 * specific vectors for specific texts. Unmatched texts fall through to
 * the hash function.
 */
function mockEmbedder(dim: number, planted?: Map<string, number[]>): EmbedFn {
  return async (texts: string[]) => {
    return texts.map((text) => {
      const fixed = planted?.get(text);
      if (fixed) {
        if (fixed.length !== dim) throw new Error(`planted vector dim mismatch`);
        return fixed;
      }
      const v: number[] = new Array(dim);
      for (let i = 0; i < dim; i++) {
        // Cheap deterministic hash; values in [0, 1).
        const seed = `${text}:${i}`;
        let h = 2166136261;
        for (let j = 0; j < seed.length; j++) {
          h = (h ^ seed.charCodeAt(j)) * 16777619;
        }
        v[i] = (h >>> 0) / 0xffffffff;
      }
      return v;
    });
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function openTestStore(
  override: Partial<SqliteVecMemoryStoreOptions> = {},
): Promise<SqliteVecMemoryStore> {
  const opts: SqliteVecMemoryStoreOptions = {
    dbPath: ':memory:',
    vectorDim: 4,
    embed: mockEmbedder(override.vectorDim ?? 4),
    ...override,
  };
  const store = await SqliteVecMemoryStore.open(opts);
  cleanups.push(async () => {
    await store.close();
  });
  return store;
}

describe('SqliteVecMemoryStore — open + schema', () => {
  it('opens an in-memory store and reports zero size', async () => {
    const store = await openTestStore();
    expect(await store.size()).toBe(0);
  });

  it('opens a file-backed store; persists across close/reopen', async () => {
    const dbPath = tmpDb();
    cleanups.push(async () => {
      await rm(dbPath, { force: true });
    });

    const s1 = await SqliteVecMemoryStore.open({
      dbPath,
      vectorDim: 4,
      embed: mockEmbedder(4),
    });
    await s1.put({ key: 'plan', value: 'durable' });
    expect(await s1.size()).toBe(1);
    await s1.close();

    const s2 = await SqliteVecMemoryStore.open({
      dbPath,
      vectorDim: 4,
      embed: mockEmbedder(4),
    });
    cleanups.push(async () => {
      await s2.close();
    });
    expect(await s2.size()).toBe(1);
    const r = await s2.query({ kind: 'structured', key: 'plan' });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.entries[0]?.value).toBe('durable');
  });

  it('runMigrations is idempotent (reopen without errors)', async () => {
    const dbPath = tmpDb();
    cleanups.push(async () => {
      await rm(dbPath, { force: true });
    });

    for (let i = 0; i < 3; i++) {
      const s = await SqliteVecMemoryStore.open({
        dbPath,
        vectorDim: 4,
        embed: mockEmbedder(4),
      });
      await s.close();
    }
    // No throw → success.
    expect(true).toBe(true);
  });
});

describe('SqliteVecMemoryStore — put + structured / recent', () => {
  it('round-trips an entry through put + structured query', async () => {
    const store = await openTestStore();
    await store.put({ key: 'plan', value: 'use OAuth' });
    const r = await store.query({ kind: 'structured', key: 'plan' });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.value).toBe('use OAuth');
    expect(r.entries[0]?.key).toBe('plan');
  });

  it('preserves complex object values via JSON', async () => {
    const store = await openTestStore();
    const complexValue = { nested: { items: [1, 2, 3], flag: true }, name: 'plan' };
    await store.put({ key: 'k', value: complexValue });
    const r = await store.query({ kind: 'structured', key: 'k' });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.entries[0]?.value).toEqual(complexValue);
  });

  it('filters by scope (single key)', async () => {
    const store = await openTestStore();
    await store.put({ key: 'k', value: 'A', scope: { productId: 'web' } });
    await store.put({ key: 'k', value: 'B', scope: { productId: 'api' } });
    const r = await store.query({
      kind: 'structured',
      key: 'k',
      scope: { productId: 'web' },
    });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.entries.map((e) => e.value)).toEqual(['A']);
  });

  it('filters by scope (AND-combined)', async () => {
    const store = await openTestStore();
    await store.put({ key: 'k', value: 1, scope: { productId: 'web', userId: 'alice' } });
    await store.put({ key: 'k', value: 2, scope: { productId: 'web', userId: 'bob' } });
    const r = await store.query({
      kind: 'structured',
      key: 'k',
      scope: { productId: 'web', userId: 'alice' },
    });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.entries.map((e) => e.value)).toEqual([1]);
  });

  it('recent returns newest-first respecting limit', async () => {
    const store = await openTestStore();
    for (let i = 1; i <= 5; i++) {
      await store.put({ key: `k${i}`, value: i });
      await new Promise((r) => setTimeout(r, 2));
    }
    const r = await store.query({ kind: 'recent', limit: 3 });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.entries.map((e) => e.value)).toEqual([5, 4, 3]);
  });

  it('returns empty result when nothing matches', async () => {
    const store = await openTestStore();
    await store.put({ key: 'a', value: 1 });
    const r = await store.query({ kind: 'structured', key: 'nonexistent' });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.entries).toEqual([]);
  });
});

describe('SqliteVecMemoryStore — similarity (KNN)', () => {
  it('ranks the planted-closest vector first', async () => {
    // Plant orthogonal-ish vectors so the closest pairing is unambiguous.
    const planted = new Map<string, number[]>([
      ['close-match', [1.0, 0.0, 0.0, 0.0]],
      ['far-match-a', [0.0, 1.0, 0.0, 0.0]],
      ['far-match-b', [0.0, 0.0, 1.0, 0.0]],
      ['the-query', [0.95, 0.05, 0.0, 0.0]], // near close-match
    ]);
    const store = await openTestStore({ embed: mockEmbedder(4, planted) });

    await store.put({ key: 'a', value: 'close-match' });
    await store.put({ key: 'b', value: 'far-match-a' });
    await store.put({ key: 'c', value: 'far-match-b' });

    const r = await store.query({ kind: 'similarity', q: 'the-query', topK: 3 });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.entries).toHaveLength(3);
    expect(r.entries[0]?.value).toBe('close-match');
  });

  it('honors topK', async () => {
    const store = await openTestStore();
    for (let i = 0; i < 10; i++) {
      await store.put({ key: 'k', value: `text-${i}` });
    }
    const r = await store.query({ kind: 'similarity', q: 'query', topK: 3 });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.entries).toHaveLength(3);
  });

  it('scope-filters similarity results', async () => {
    const planted = new Map<string, number[]>([
      ['web-A', [1.0, 0.0, 0.0, 0.0]],
      ['api-A', [1.0, 0.0, 0.0, 0.0]], // identical to web-A vector — same distance
      ['the-query', [1.0, 0.0, 0.0, 0.0]],
    ]);
    const store = await openTestStore({ embed: mockEmbedder(4, planted) });

    await store.put({ key: 'k', value: 'web-A', scope: { productId: 'web' } });
    await store.put({ key: 'k', value: 'api-A', scope: { productId: 'api' } });

    const r = await store.query({
      kind: 'similarity',
      q: 'the-query',
      topK: 5,
      scope: { productId: 'web' },
    });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.value).toBe('web-A');
    expect(r.entries[0]?.scope.productId).toBe('web');
  });

  it('non-string values skip embedding (absent from similarity results)', async () => {
    const store = await openTestStore();
    // Object value — won't be embedded.
    await store.put({ key: 'k', value: { nested: 'object' } });
    // String value — will be embedded.
    await store.put({ key: 'k', value: 'embedded-text' });

    const r = await store.query({ kind: 'similarity', q: 'anything', topK: 5 });
    if (r.kind !== 'ok') throw new Error('expected ok');
    // Only the embedded entry surfaces in similarity results.
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.value).toBe('embedded-text');

    // But structured query finds both.
    const all = await store.query({ kind: 'structured', key: 'k' });
    if (all.kind !== 'ok') throw new Error('expected ok');
    expect(all.entries).toHaveLength(2);
  });

  it('graph queries return unsupported', async () => {
    const store = await openTestStore();
    const r = await store.query({ kind: 'graph', from: 'mem_1' });
    expect(r.kind).toBe('unsupported');
    if (r.kind !== 'unsupported') return;
    expect(r.reason).toMatch(/Neo4j/);
  });
});

describe('SqliteVecMemoryStore — error paths', () => {
  it('throws on dim mismatch (embedder returns wrong dim)', async () => {
    const store = await openTestStore({
      vectorDim: 4,
      embed: mockEmbedder(8), // wrong dim
    });
    await expect(store.put({ key: 'k', value: 'mismatched' })).rejects.toThrow(/dim mismatch/);
  });

  it('throws when used after close', async () => {
    const store = await openTestStore();
    await store.close();
    cleanups.pop(); // already closed; skip the cleanup
    await expect(store.put({ key: 'k', value: 'v' })).rejects.toThrow(/closed/);
  });
});

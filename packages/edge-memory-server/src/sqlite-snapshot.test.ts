/**
 * Integration tests for SqliteSnapshotStore — schema + roundtrip +
 * persistence across reopens.
 */

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteSnapshotStore } from './sqlite-snapshot.ts';
import type { MemoryEntry } from './store.ts';

const tmpDb = () => join(tmpdir(), `snap-${randomUUID().slice(0, 8)}.sqlite`);

function entry(id: string, key: string, value: unknown): MemoryEntry {
  return {
    id,
    createdAt: '2026-05-08T00:00:00.000Z',
    key,
    value,
    scope: { sessionId: 'abc' },
    provenance: { feedback: 'unconfirmed' },
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe('SqliteSnapshotStore', () => {
  it('save + load round-trips entries verbatim', async () => {
    const store = await SqliteSnapshotStore.open({ dbPath: ':memory:' });
    cleanups.push(async () => store.close());

    const snap = await store.save({ sessionId: 'abc' }, [
      entry('mem_1', 'k1', 'A'),
      entry('mem_2', 'k2', { nested: true }),
    ]);
    const loaded = await store.load(snap.id);
    expect(loaded?.entries).toHaveLength(2);
    expect(loaded?.entries[0]?.key).toBe('k1');
    expect(loaded?.entries[1]?.value).toEqual({ nested: true });
    expect(loaded?.scope.sessionId).toBe('abc');
  });

  it('persists across reopen', async () => {
    const dbPath = tmpDb();
    const s1 = await SqliteSnapshotStore.open({ dbPath });
    const snap = await s1.save({ sessionId: 'persist' }, [entry('mem_1', 'k', 'v')]);
    await s1.close();

    const s2 = await SqliteSnapshotStore.open({ dbPath });
    cleanups.push(async () => {
      await s2.close();
      await rm(dbPath, { force: true });
      await rm(`${dbPath}-shm`, { force: true });
      await rm(`${dbPath}-wal`, { force: true });
    });
    const loaded = await s2.load(snap.id);
    expect(loaded?.entries[0]?.value).toBe('v');
  });

  it('size + remove', async () => {
    const store = await SqliteSnapshotStore.open({ dbPath: ':memory:' });
    cleanups.push(async () => store.close());

    expect(await store.size()).toBe(0);
    const a = await store.save({ sessionId: 'x' }, []);
    await store.save({ sessionId: 'y' }, []);
    expect(await store.size()).toBe(2);
    expect(await store.remove(a.id)).toBe(true);
    expect(await store.remove(a.id)).toBe(false);
    expect(await store.size()).toBe(1);
  });
});

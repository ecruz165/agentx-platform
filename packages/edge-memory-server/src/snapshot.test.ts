/**
 * Unit tests for the SnapshotStore interface (InMemorySnapshotStore).
 * Server-level snapshot/restore round-trip tests live in server.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { InMemorySnapshotStore } from './snapshot.ts';
import type { MemoryEntry } from './store.ts';

function entry(id: string, key: string, value: unknown): MemoryEntry {
  return {
    id,
    createdAt: '2026-05-08T00:00:00.000Z',
    key,
    value,
    scope: {},
    provenance: { feedback: 'unconfirmed' },
  };
}

describe('InMemorySnapshotStore', () => {
  it('save assigns id + createdAt; load round-trips', async () => {
    const s = new InMemorySnapshotStore();
    const snap = await s.save({ sessionId: 'abc' }, [entry('mem_1', 'k', 'v')]);
    expect(snap.id).toMatch(/^snap_/);
    expect(snap.createdAt).toMatch(/^\d{4}-/);

    const loaded = await s.load(snap.id);
    expect(loaded?.id).toBe(snap.id);
    expect(loaded?.entries).toHaveLength(1);
    expect(loaded?.scope.sessionId).toBe('abc');
  });

  it('load returns null for unknown id', async () => {
    const s = new InMemorySnapshotStore();
    expect(await s.load('snap_does_not_exist')).toBeNull();
  });

  it('size + remove', async () => {
    const s = new InMemorySnapshotStore();
    expect(await s.size()).toBe(0);
    const a = await s.save({ sessionId: 'x' }, []);
    const b = await s.save({ sessionId: 'y' }, []);
    expect(await s.size()).toBe(2);

    expect(await s.remove(a.id)).toBe(true);
    expect(await s.remove(a.id)).toBe(false); // already gone
    expect(await s.size()).toBe(1);
    expect(await s.load(b.id)).not.toBeNull();
  });
});

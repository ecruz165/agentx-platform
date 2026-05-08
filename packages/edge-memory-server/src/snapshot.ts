/**
 * Snapshot + restore (PRD F5) — capture the entries of a scope at a
 * point in time, restore them later. The classic rollback affordance:
 * a session writes speculative state, then on failure restores from
 * the snapshot taken before the speculative work began.
 *
 * Storage is a separate concern from MemoryStore — a snapshot is a
 * frozen blob, not a queryable surface. Two backends ship:
 *   - InMemorySnapshotStore — Map-based; vanishes on restart. Tests + dev.
 *   - SqliteSnapshotStore — JSON blob in its own SQLite file. Production.
 *
 * Restore modes:
 *   - replace (default): forget current scope, then put snapshot entries.
 *   - merge: keep current contents; put snapshot entries on top.
 */

import type { MemoryEntry, MemoryScope } from './store.ts';

export interface MemorySnapshot {
  id: string;
  createdAt: string;
  scope: MemoryScope;
  entries: MemoryEntry[];
}

export interface SnapshotStore {
  save(scope: MemoryScope, entries: MemoryEntry[]): Promise<MemorySnapshot>;
  load(snapshotId: string): Promise<MemorySnapshot | null>;
  remove(snapshotId: string): Promise<boolean>;
  size(): Promise<number>;
}

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<string, MemorySnapshot>();
  private nextId = 1;

  async save(scope: MemoryScope, entries: MemoryEntry[]): Promise<MemorySnapshot> {
    const snap: MemorySnapshot = {
      id: `snap_${this.nextId++}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      scope,
      entries,
    };
    this.snapshots.set(snap.id, snap);
    return snap;
  }

  async load(snapshotId: string): Promise<MemorySnapshot | null> {
    return this.snapshots.get(snapshotId) ?? null;
  }

  async remove(snapshotId: string): Promise<boolean> {
    return this.snapshots.delete(snapshotId);
  }

  async size(): Promise<number> {
    return this.snapshots.size;
  }
}

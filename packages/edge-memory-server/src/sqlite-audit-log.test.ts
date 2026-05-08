/**
 * Integration tests for SqliteAuditLog. Real better-sqlite3, no
 * sqlite-vec needed (audit log uses plain SQL).
 *
 * Coverage: schema + persistence + filtering parity with
 * InMemoryAuditLog (the same scenarios that pass against the
 * in-memory impl should pass here).
 */

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACTOR } from './audit.ts';
import { SqliteAuditLog } from './sqlite-audit-log.ts';

const tmpDb = () => join(tmpdir(), `aud-${randomUUID().slice(0, 8)}.sqlite`);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function openTestLog(): Promise<SqliteAuditLog> {
  const log = await SqliteAuditLog.open({ dbPath: ':memory:' });
  cleanups.push(async () => {
    await log.close();
  });
  return log;
}

describe('SqliteAuditLog — open + schema', () => {
  it('opens an in-memory log; reports zero size', async () => {
    const log = await openTestLog();
    expect(await log.size()).toBe(0);
  });

  it('persists across reopen on a file-backed log', async () => {
    const dbPath = tmpDb();
    cleanups.push(async () => {
      await rm(dbPath, { force: true });
    });

    const a = await SqliteAuditLog.open({ dbPath });
    await a.append({
      op: 'put',
      actor: DEFAULT_ACTOR,
      count: 1,
      entryIds: ['mem_1'],
      scope: { productId: 'web' },
    });
    await a.close();

    const b = await SqliteAuditLog.open({ dbPath });
    cleanups.push(async () => {
      await b.close();
    });
    expect(await b.size()).toBe(1);
    const events = await b.query();
    expect(events[0]?.scope?.productId).toBe('web');
    expect(events[0]?.entryIds).toEqual(['mem_1']);
  });

  it('idempotent migrations across multiple opens', async () => {
    const dbPath = tmpDb();
    cleanups.push(async () => {
      await rm(dbPath, { force: true });
    });
    for (let i = 0; i < 3; i++) {
      const log = await SqliteAuditLog.open({ dbPath });
      await log.close();
    }
    expect(true).toBe(true); // no throw → success
  });
});

describe('SqliteAuditLog — query', () => {
  it('returns newest first', async () => {
    const log = await openTestLog();
    await log.append({ op: 'put', actor: DEFAULT_ACTOR, count: 1, entryIds: ['m1'] });
    await new Promise((r) => setTimeout(r, 10));
    await log.append({ op: 'forget', actor: DEFAULT_ACTOR, count: 5, entryIds: [] });
    const events = await log.query();
    expect(events[0]?.op).toBe('forget');
    expect(events[1]?.op).toBe('put');
  });

  it('filters by op', async () => {
    const log = await openTestLog();
    await log.append({ op: 'put', actor: DEFAULT_ACTOR, count: 1, entryIds: ['m1'] });
    await log.append({ op: 'forget', actor: DEFAULT_ACTOR, count: 1, entryIds: ['m1'] });
    await log.append({ op: 'import', actor: DEFAULT_ACTOR, count: 100, entryIds: ['m2'] });
    const onlyImport = await log.query({ op: 'import' });
    expect(onlyImport).toHaveLength(1);
    expect(onlyImport[0]?.count).toBe(100);
  });

  it('filters by scope (subset match, AND-combined)', async () => {
    const log = await openTestLog();
    await log.append({
      op: 'put',
      actor: DEFAULT_ACTOR,
      count: 1,
      entryIds: ['m1'],
      scope: { productId: 'web', userId: 'alice' },
    });
    await log.append({
      op: 'put',
      actor: DEFAULT_ACTOR,
      count: 1,
      entryIds: ['m2'],
      scope: { productId: 'web', userId: 'bob' },
    });
    const onlyAlice = await log.query({ scope: { userId: 'alice' } });
    expect(onlyAlice).toHaveLength(1);
    expect(onlyAlice[0]?.entryIds).toEqual(['m1']);
  });

  it('filters by since/until time range', async () => {
    const log = await openTestLog();
    await log.append({ op: 'put', actor: DEFAULT_ACTOR, count: 1, entryIds: ['m1'] });
    await new Promise((r) => setTimeout(r, 20));
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    await log.append({ op: 'put', actor: DEFAULT_ACTOR, count: 1, entryIds: ['m2'] });

    const before = await log.query({ until: cutoff });
    expect(before).toHaveLength(1);
    expect(before[0]?.entryIds).toEqual(['m1']);

    const after = await log.query({ since: cutoff });
    expect(after).toHaveLength(1);
    expect(after[0]?.entryIds).toEqual(['m2']);
  });

  it('honors limit', async () => {
    const log = await openTestLog();
    for (let i = 0; i < 10; i++) {
      await log.append({ op: 'put', actor: DEFAULT_ACTOR, count: 1, entryIds: [`m${i}`] });
    }
    const events = await log.query({ limit: 3 });
    expect(events).toHaveLength(3);
  });

  it('preserves bulk entryIds arrays through serialization', async () => {
    const log = await openTestLog();
    const ids = Array.from({ length: 50 }, (_, i) => `mem_${i}`);
    await log.append({ op: 'forget', actor: DEFAULT_ACTOR, count: 50, entryIds: ids });
    const events = await log.query();
    expect(events[0]?.entryIds).toEqual(ids);
  });
});

describe('SqliteAuditLog — closed state', () => {
  it('append throws after close', async () => {
    const log = await openTestLog();
    await log.close();
    cleanups.pop(); // already closed
    await expect(
      log.append({ op: 'put', actor: DEFAULT_ACTOR, count: 1, entryIds: ['x'] }),
    ).rejects.toThrow(/closed/);
  });

  it('query returns empty after close', async () => {
    const log = await openTestLog();
    await log.append({ op: 'put', actor: DEFAULT_ACTOR, count: 1, entryIds: ['m1'] });
    await log.close();
    cleanups.pop();
    expect(await log.query()).toEqual([]);
    expect(await log.size()).toBe(0);
  });
});

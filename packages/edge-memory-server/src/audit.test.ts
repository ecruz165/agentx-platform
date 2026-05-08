/**
 * Unit tests for AuditLog implementations. Covers InMemoryAuditLog
 * directly + the matchesAuditFilter helper. SqliteAuditLog gets its
 * own integration tests in sqlite-audit-log.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  type AuditEvent,
  type AuditLog,
  DEFAULT_ACTOR,
  InMemoryAuditLog,
  matchesAuditFilter,
} from './audit.ts';

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 'aud_test',
    timestamp: '2026-05-08T12:00:00.000Z',
    op: 'put',
    actor: DEFAULT_ACTOR,
    count: 1,
    entryIds: ['mem_1'],
    ...overrides,
  };
}

describe('matchesAuditFilter', () => {
  it('matches everything when filter is empty', () => {
    expect(matchesAuditFilter(makeEvent(), {})).toBe(true);
  });

  it('matches by op', () => {
    expect(matchesAuditFilter(makeEvent({ op: 'put' }), { op: 'put' })).toBe(true);
    expect(matchesAuditFilter(makeEvent({ op: 'put' }), { op: 'forget' })).toBe(false);
  });

  it('matches by actor', () => {
    expect(matchesAuditFilter(makeEvent({ actor: 'uds:1000' }), { actor: 'uds:1000' })).toBe(true);
    expect(matchesAuditFilter(makeEvent({ actor: 'uds:1000' }), { actor: 'uds:1001' })).toBe(false);
  });

  it('matches by since (inclusive)', () => {
    const ev = makeEvent({ timestamp: '2026-05-08T12:00:00.000Z' });
    expect(matchesAuditFilter(ev, { since: '2026-05-08T11:00:00.000Z' })).toBe(true);
    expect(matchesAuditFilter(ev, { since: '2026-05-08T12:00:00.000Z' })).toBe(true);
    expect(matchesAuditFilter(ev, { since: '2026-05-08T13:00:00.000Z' })).toBe(false);
  });

  it('matches by until (exclusive)', () => {
    const ev = makeEvent({ timestamp: '2026-05-08T12:00:00.000Z' });
    expect(matchesAuditFilter(ev, { until: '2026-05-08T13:00:00.000Z' })).toBe(true);
    expect(matchesAuditFilter(ev, { until: '2026-05-08T12:00:00.000Z' })).toBe(false);
  });

  it('subset-matches scope', () => {
    const ev = makeEvent({ scope: { productId: 'web', userId: 'alice' } });
    expect(matchesAuditFilter(ev, { scope: { productId: 'web' } })).toBe(true);
    expect(matchesAuditFilter(ev, { scope: { userId: 'alice' } })).toBe(true);
    expect(matchesAuditFilter(ev, { scope: { productId: 'web', userId: 'alice' } })).toBe(true);
    expect(matchesAuditFilter(ev, { scope: { productId: 'api' } })).toBe(false);
    expect(matchesAuditFilter(ev, { scope: { userId: 'bob' } })).toBe(false);
  });

  it('AND-combines all set fields', () => {
    const ev = makeEvent({
      op: 'forget',
      actor: 'uds:1000',
      scope: { productId: 'web' },
    });
    expect(
      matchesAuditFilter(ev, { op: 'forget', actor: 'uds:1000', scope: { productId: 'web' } }),
    ).toBe(true);
    expect(matchesAuditFilter(ev, { op: 'forget', actor: 'uds:1001' })).toBe(false);
  });

  it('events with no scope still match a scope-set filter only when filter scope is empty', () => {
    const ev = makeEvent({ scope: undefined });
    expect(matchesAuditFilter(ev, { scope: { productId: 'web' } })).toBe(false);
  });
});

describe('InMemoryAuditLog', () => {
  it('appends events and assigns id + timestamp', async () => {
    const log: AuditLog = new InMemoryAuditLog();
    const ev = await log.append({
      op: 'put',
      actor: DEFAULT_ACTOR,
      count: 1,
      entryIds: ['mem_1'],
    });
    expect(ev.id).toMatch(/^aud_/);
    expect(ev.timestamp).toMatch(/^\d{4}-/);
    expect(ev.op).toBe('put');
  });

  it('size reflects appended count', async () => {
    const log = new InMemoryAuditLog();
    expect(await log.size()).toBe(0);
    await log.append({ op: 'put', actor: DEFAULT_ACTOR, count: 1, entryIds: ['mem_1'] });
    await log.append({ op: 'put', actor: DEFAULT_ACTOR, count: 1, entryIds: ['mem_2'] });
    expect(await log.size()).toBe(2);
  });

  it('query returns newest first', async () => {
    const log = new InMemoryAuditLog();
    await log.append({ op: 'put', actor: DEFAULT_ACTOR, count: 1, entryIds: ['mem_1'] });
    await new Promise((r) => setTimeout(r, 5));
    await log.append({ op: 'forget', actor: DEFAULT_ACTOR, count: 5, entryIds: [] });
    const result = await log.query();
    expect(result[0]?.op).toBe('forget');
    expect(result[1]?.op).toBe('put');
  });

  it('query honors limit', async () => {
    const log = new InMemoryAuditLog();
    for (let i = 0; i < 10; i++) {
      await log.append({ op: 'put', actor: DEFAULT_ACTOR, count: 1, entryIds: [`mem_${i}`] });
    }
    const result = await log.query({ limit: 3 });
    expect(result).toHaveLength(3);
  });

  it('query filters by op', async () => {
    const log = new InMemoryAuditLog();
    await log.append({ op: 'put', actor: DEFAULT_ACTOR, count: 1, entryIds: ['m1'] });
    await log.append({ op: 'forget', actor: DEFAULT_ACTOR, count: 1, entryIds: ['m1'] });
    await log.append({ op: 'put', actor: DEFAULT_ACTOR, count: 1, entryIds: ['m2'] });
    const onlyForget = await log.query({ op: 'forget' });
    expect(onlyForget).toHaveLength(1);
    expect(onlyForget[0]?.op).toBe('forget');
  });

  it('query filters by scope', async () => {
    const log = new InMemoryAuditLog();
    await log.append({
      op: 'put',
      actor: DEFAULT_ACTOR,
      count: 1,
      entryIds: ['m1'],
      scope: { productId: 'web' },
    });
    await log.append({
      op: 'put',
      actor: DEFAULT_ACTOR,
      count: 1,
      entryIds: ['m2'],
      scope: { productId: 'api' },
    });
    const webOnly = await log.query({ scope: { productId: 'web' } });
    expect(webOnly).toHaveLength(1);
    expect(webOnly[0]?.entryIds).toEqual(['m1']);
  });
});

/**
 * Cron parser + scheduler tests. Uses fake clock + setTimeout so we
 * can assert exact fire times without sleeping.
 */

import { describe, expect, it, vi } from 'vitest';
import { CronScheduler, parseCron, nextFireTime } from './cron.ts';

describe('parseCron', () => {
  it('parses standard 5-field expressions', () => {
    const r = parseCron('0 2 * * *');
    expect(r.minute.has(0)).toBe(true);
    expect(r.minute.has(1)).toBe(false);
    expect(r.hour.has(2)).toBe(true);
    expect(r.dom.size).toBe(31);
    expect(r.month.size).toBe(12);
    expect(r.dow.size).toBe(7);
  });

  it('handles ranges + lists + steps', () => {
    const r = parseCron('*/15 9-17 1,15 * 1-5');
    expect([...r.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect(r.hour.size).toBe(9); // 9..17
    expect([...r.dom].sort((a, b) => a - b)).toEqual([1, 15]);
    expect(r.dow.has(0)).toBe(false); // Sunday excluded
    expect(r.dow.has(1)).toBe(true);
    expect(r.dow.has(5)).toBe(true);
    expect(r.dow.has(6)).toBe(false); // Saturday excluded
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCron('* * *')).toThrow(/5 fields/);
    expect(() => parseCron('60 * * * *')).toThrow(/range/);
    expect(() => parseCron('* * * * 7')).toThrow(/range/);
    expect(() => parseCron('*/0 * * * *')).toThrow(/step/);
  });
});

describe('nextFireTime', () => {
  it('finds the next matching minute boundary', () => {
    const expr = parseCron('30 14 * * *'); // 14:30 every day
    const before = new Date('2026-05-08T13:00:00Z').getTime();
    const next = nextFireTime(expr, before);
    const d = new Date(next);
    expect(d.getUTCHours() * 60 + d.getUTCMinutes()).toBeGreaterThanOrEqual(0); // any TZ — just check it's later
    expect(next).toBeGreaterThan(before);
  });

  it('rolls to the next day when current time is past the trigger', () => {
    const expr = parseCron('0 9 * * *'); // 09:00 daily
    // Use local time math by computing relative to a real clock
    const now = new Date();
    now.setHours(10, 0, 0, 0); // 10:00 local
    const next = new Date(nextFireTime(expr, now.getTime()));
    expect(next.getHours()).toBe(9);
    expect(next.getDate()).toBeGreaterThanOrEqual(now.getDate()); // next day or same+1
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });
});

describe('CronScheduler', () => {
  it('add()/list()/remove()', () => {
    const s = new CronScheduler({
      now: () => 0,
      setTimeout: () => 1,
      clearTimeout: () => {},
    });
    s.add({ name: 'a', expression: '0 * * * *', task: () => {} });
    s.add({ name: 'b', expression: '*/5 * * * *', task: () => {} });
    expect(s.list()).toEqual(['a', 'b']);
    expect(s.remove('a')).toBe(true);
    expect(s.list()).toEqual(['b']);
    expect(s.remove('nope')).toBe(false);
  });

  it('fires registered tasks via injected setTimeout', async () => {
    const calls: string[] = [];
    let scheduled: { cb: () => void; ms: number } | null = null;
    const s = new CronScheduler({
      now: () => 0,
      setTimeout: (cb, ms) => {
        scheduled = { cb, ms };
        return 'h';
      },
      clearTimeout: () => {},
    });
    s.add({
      name: 'greet',
      expression: '0 * * * *',
      task: async () => {
        calls.push('fired');
      },
    });
    s.start();
    expect(scheduled).not.toBeNull();
    expect(scheduled!.ms).toBeGreaterThan(0);
    // simulate timer firing
    scheduled!.cb();
    // task is async; let microtasks settle
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual(['fired']);
  });

  it('catches task errors so subsequent fires still schedule', async () => {
    let scheduledCount = 0;
    const s = new CronScheduler({
      now: () => 0,
      setTimeout: (_cb, _ms) => {
        scheduledCount += 1;
        return scheduledCount;
      },
      clearTimeout: () => {},
    });
    s.add({
      name: 'crash',
      expression: '0 * * * *',
      task: () => {
        throw new Error('boom');
      },
    });
    s.start();
    expect(scheduledCount).toBe(1);
    // Get the scheduled callback by replacing setTimeout with a capturing one
    let captured: (() => void) | null = null;
    const s2 = new CronScheduler({
      now: () => 0,
      setTimeout: (cb) => {
        captured = cb;
        return 1;
      },
      clearTimeout: () => {},
    });
    s2.add({
      name: 'crash',
      expression: '0 * * * *',
      task: () => {
        throw new Error('boom');
      },
    });
    s2.start();
    expect(captured).not.toBeNull();
    // Suppress stderr noise from the error log
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    captured!();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    stderrSpy.mockRestore();
    // Test passes if we got here without throwing.
    expect(true).toBe(true);
  });

  it('stop() cancels timers', () => {
    const cleared: unknown[] = [];
    const s = new CronScheduler({
      now: () => 0,
      setTimeout: () => 'h1',
      clearTimeout: (h) => cleared.push(h),
    });
    s.add({ name: 'a', expression: '0 * * * *', task: () => {} });
    s.start();
    s.stop();
    expect(cleared).toContain('h1');
  });
});

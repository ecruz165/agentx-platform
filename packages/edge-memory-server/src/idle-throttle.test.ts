/**
 * Unit tests for IdleThrottle. Drives the state machine with an
 * injected clock so we don't have to actually wait 10 minutes.
 */

import { describe, expect, it, vi } from 'vitest';
import { IdleThrottle } from './idle-throttle.ts';

function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('IdleThrottle — state transitions', () => {
  it('starts warm', () => {
    expect(new IdleThrottle().state).toBe('warm');
  });

  it('checkIdle flips warm→idle after idleTimeout with no activity', async () => {
    const clock = makeClock();
    const t = new IdleThrottle({
      idleTimeoutMs: 1000,
      now: clock.now,
    });
    clock.advance(500);
    await t.checkIdle();
    expect(t.state).toBe('warm'); // not enough time

    clock.advance(600); // total 1100ms since last activity
    await t.checkIdle();
    expect(t.state).toBe('idle');
  });

  it('recordActivity resets the idle clock', async () => {
    const clock = makeClock();
    const t = new IdleThrottle({ idleTimeoutMs: 1000, now: clock.now });
    clock.advance(900);
    t.recordActivity();
    clock.advance(900);
    await t.checkIdle();
    // Total 1800ms but recordActivity reset clock at 900ms in.
    // So only 900ms since last activity → still warm.
    expect(t.state).toBe('warm');
  });

  it('ensureWarm transitions idle→warm and runs onWarm exactly once for concurrent callers', async () => {
    const clock = makeClock();
    const onWarm = vi.fn(async () => {
      // Simulate a 50ms warmup.
      await new Promise((r) => setTimeout(r, 50));
    });
    const t = new IdleThrottle({
      idleTimeoutMs: 100,
      now: clock.now,
      onWarm,
    });
    clock.advance(200);
    await t.checkIdle();
    expect(t.state).toBe('idle');

    // Three concurrent ensureWarm calls — only ONE should trigger onWarm.
    await Promise.all([t.ensureWarm(), t.ensureWarm(), t.ensureWarm()]);
    expect(t.state).toBe('warm');
    expect(onWarm).toHaveBeenCalledTimes(1);
  });

  it('ensureWarm is a no-op when already warm', async () => {
    const onWarm = vi.fn(async () => {});
    const t = new IdleThrottle({ onWarm });
    await t.ensureWarm();
    expect(onWarm).not.toHaveBeenCalled();
    expect(t.state).toBe('warm');
  });
});

describe('IdleThrottle — hooks', () => {
  it('runs onIdle when transitioning warm→idle', async () => {
    const clock = makeClock();
    const onIdle = vi.fn(async () => {});
    const t = new IdleThrottle({
      idleTimeoutMs: 100,
      now: clock.now,
      onIdle,
    });
    clock.advance(200);
    await t.checkIdle();
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(t.state).toBe('idle');
  });

  it('onIdle failure keeps state warm (no half-state)', async () => {
    const clock = makeClock();
    const warns: string[] = [];
    const t = new IdleThrottle({
      idleTimeoutMs: 100,
      now: clock.now,
      onIdle: async () => {
        throw new Error('teardown failed');
      },
      warn: (m) => warns.push(m),
    });
    clock.advance(200);
    await t.checkIdle();
    expect(t.state).toBe('warm');
    expect(warns[0]).toMatch(/onIdle failed: teardown failed/);
  });

  it('onWarm failure keeps state idle and surfaces error', async () => {
    const clock = makeClock();
    const warns: string[] = [];
    const t = new IdleThrottle({
      idleTimeoutMs: 100,
      now: clock.now,
      onWarm: async () => {
        throw new Error('reopen failed');
      },
      warn: (m) => warns.push(m),
    });
    clock.advance(200);
    await t.checkIdle();
    expect(t.state).toBe('idle');

    await expect(t.ensureWarm()).rejects.toThrow(/reopen failed/);
    expect(t.state).toBe('idle'); // still idle on failure
    expect(warns[0]).toMatch(/onWarm failed/);
  });
});

describe('IdleThrottle — periodic timer', () => {
  it('start() / stop() are idempotent', () => {
    const t = new IdleThrottle();
    t.start();
    t.start(); // no-op
    t.stop();
    t.stop(); // no-op
  });

  it('start() schedules checkIdle at checkIntervalMs cadence', async () => {
    vi.useFakeTimers();
    try {
      const clock = makeClock();
      const onIdle = vi.fn(async () => {});
      const t = new IdleThrottle({
        idleTimeoutMs: 100,
        checkIntervalMs: 50,
        now: clock.now,
        onIdle,
      });
      t.start();
      clock.advance(200); // already past idleTimeout
      await vi.advanceTimersByTimeAsync(60); // one check fires
      expect(onIdle).toHaveBeenCalledTimes(1);
      t.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

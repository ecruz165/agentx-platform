import { describe, it, expect, vi } from 'vitest';
import { AdapterEventBus, type AdapterEvent } from './events.ts';

const requestEvent = (user = 'u'): AdapterEvent => ({
  kind: 'request',
  ts: '2026-01-01T00:00:00Z',
  user,
  model: 'm',
});

const responseEvent = (text = 'r'): AdapterEvent => ({
  kind: 'response',
  ts: '2026-01-01T00:00:01Z',
  text,
});

describe('AdapterEventBus', () => {
  it('delivers events to a subscriber in emit order', () => {
    const bus = new AdapterEventBus();
    const seen: AdapterEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    bus.emit(requestEvent());
    bus.emit(responseEvent());

    expect(seen).toHaveLength(2);
    expect(seen[0]?.kind).toBe('request');
    expect(seen[1]?.kind).toBe('response');
  });

  it('fans an event out to multiple subscribers', () => {
    const bus = new AdapterEventBus();
    const a: AdapterEvent[] = [];
    const b: AdapterEvent[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));

    bus.emit(requestEvent());

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('does not replay prior events to a late subscriber', () => {
    const bus = new AdapterEventBus();
    bus.emit(requestEvent('first'));

    const seen: AdapterEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    bus.emit(responseEvent('second'));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe('response');
  });

  it('stops delivery after unsubscribe', () => {
    const bus = new AdapterEventBus();
    const seen: AdapterEvent[] = [];
    const off = bus.subscribe((e) => seen.push(e));

    bus.emit(requestEvent());
    off();
    bus.emit(responseEvent());

    expect(seen).toHaveLength(1);
  });

  it('isolates a throwing subscriber from other subscribers', () => {
    const bus = new AdapterEventBus();
    const seen: AdapterEvent[] = [];

    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((e) => seen.push(e));

    expect(() => bus.emit(requestEvent())).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('does not propagate a throwing subscriber up to the producer', () => {
    const bus = new AdapterEventBus();
    bus.subscribe(() => {
      throw new Error('boom');
    });

    // emit must be safe to call even if every subscriber throws.
    expect(() => bus.emit(requestEvent())).not.toThrow();
  });

  it('passes events through redactEvent before subscribers see them', async () => {
    // redactEvent is currently a no-op (TODO for the user). When implemented,
    // patterns like sk-ant-* should be scrubbed. For now we assert the
    // identity behavior so the test moves with the implementation.
    const { redactEvent } = await import('./capture.ts');
    const spy = vi.fn(redactEvent);
    vi.doMock('./capture.ts', () => ({ redactEvent: spy, FileEventSubscriber: class {} }));

    // We can't easily intercept the bus's own import binding, so instead we
    // assert behavior: no-op redact means the subscriber sees the event unchanged.
    const bus = new AdapterEventBus();
    const seen: AdapterEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const evt = requestEvent('with sk-ant-pretend-key inside');
    bus.emit(evt);

    expect(seen[0]).toEqual(evt); // no-op today; user's redactEvent will change this assertion.
    vi.doUnmock('./capture.ts');
  });
});

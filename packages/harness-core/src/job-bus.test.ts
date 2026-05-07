import { type AdapterEvent, AdapterEventBus } from '@ecruz165/agent-adapter';
import { describe, expect, it } from 'vitest';
import { bridgeAdapter, type Envelope, JobBus } from './job-bus.ts';

const requestEvent = (user = 'u'): AdapterEvent => ({
  kind: 'request',
  ts: '2026-01-01T00:00:00Z',
  user,
  model: 'm',
});

describe('JobBus', () => {
  it('delivers a published event to a subscriber as a tagged envelope', () => {
    const bus = new JobBus();
    const seen: Envelope[] = [];
    bus.subscribe('job-1', (e) => seen.push(e));

    bus.publish('job-1', 'agent-a', requestEvent('hi'));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ jobId: 'job-1', agentId: 'agent-a' });
    expect(seen[0]?.event.kind).toBe('request');
  });

  it('isolates jobs — a subscriber to job-A never sees job-B events', () => {
    const bus = new JobBus();
    const a: Envelope[] = [];
    const b: Envelope[] = [];
    bus.subscribe('job-A', (e) => a.push(e));
    bus.subscribe('job-B', (e) => b.push(e));

    bus.publish('job-A', 'planner', requestEvent());
    bus.publish('job-B', 'reviewer', requestEvent());

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.jobId).toBe('job-A');
    expect(b[0]?.jobId).toBe('job-B');
  });

  it('fans events out to multiple subscribers of the same job', () => {
    const bus = new JobBus();
    const a: Envelope[] = [];
    const b: Envelope[] = [];
    bus.subscribe('job-1', (e) => a.push(e));
    bus.subscribe('job-1', (e) => b.push(e));

    bus.publish('job-1', 'agent-a', requestEvent());

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('drops publications when no subscribers exist for that job', () => {
    const bus = new JobBus();
    expect(() => bus.publish('orphan', 'agent', requestEvent())).not.toThrow();
    expect(bus.subscriberCount('orphan')).toBe(0);
  });

  it('unsubscribe stops delivery and prunes empty job entries', () => {
    const bus = new JobBus();
    const seen: Envelope[] = [];
    const off = bus.subscribe('job-1', (e) => seen.push(e));

    bus.publish('job-1', 'agent-a', requestEvent());
    expect(seen).toHaveLength(1);
    expect(bus.subscriberCount('job-1')).toBe(1);

    off();
    bus.publish('job-1', 'agent-a', requestEvent());

    expect(seen).toHaveLength(1);
    expect(bus.subscriberCount('job-1')).toBe(0);
  });

  it('isolates one throwing subscriber from others', () => {
    const bus = new JobBus();
    const seen: Envelope[] = [];
    bus.subscribe('job-1', () => {
      throw new Error('boom');
    });
    bus.subscribe('job-1', (e) => seen.push(e));

    expect(() => bus.publish('job-1', 'agent-a', requestEvent())).not.toThrow();
    expect(seen).toHaveLength(1);
  });
});

describe('bridgeAdapter', () => {
  it('forwards adapter events onto the job bus with the correct envelope', () => {
    const adapter = new AdapterEventBus();
    const bus = new JobBus();
    const seen: Envelope[] = [];
    bus.subscribe('job-1', (e) => seen.push(e));

    const off = bridgeAdapter(bus, 'job-1', 'planner', adapter);

    adapter.emit(requestEvent('first'));
    adapter.emit({ kind: 'response', ts: 't2', text: 'hi' });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ jobId: 'job-1', agentId: 'planner' });
    expect(seen[0]?.event.kind).toBe('request');
    expect(seen[1]?.event.kind).toBe('response');

    off();
  });

  it('returned unsubscribe stops forwarding', () => {
    const adapter = new AdapterEventBus();
    const bus = new JobBus();
    const seen: Envelope[] = [];
    bus.subscribe('job-1', (e) => seen.push(e));

    const off = bridgeAdapter(bus, 'job-1', 'planner', adapter);
    adapter.emit(requestEvent());
    off();
    adapter.emit({ kind: 'response', ts: 't2', text: 'after-off' });

    expect(seen).toHaveLength(1);
  });

  it('multiple bridged agents publish onto the same job', () => {
    const planner = new AdapterEventBus();
    const reviewer = new AdapterEventBus();
    const bus = new JobBus();
    const seen: Envelope[] = [];
    bus.subscribe('job-1', (e) => seen.push(e));

    bridgeAdapter(bus, 'job-1', 'planner', planner);
    bridgeAdapter(bus, 'job-1', 'reviewer', reviewer);

    planner.emit(requestEvent('plan'));
    reviewer.emit(requestEvent('review'));

    expect(seen.map((e) => e.agentId)).toEqual(['planner', 'reviewer']);
  });
});

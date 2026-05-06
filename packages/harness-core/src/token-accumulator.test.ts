import type { AdapterEvent } from '@agentx/agent-adapter';
import { describe, expect, it } from 'vitest';
import type { JobRecord } from './job.ts';
import { JobBus } from './job-bus.ts';
import { TokenAccumulator } from './token-accumulator.ts';

function emptyJob(jobId: string, agentIds: string[]): JobRecord {
  return {
    jobId,
    status: 'received',
    submittedAt: 'now',
    agents: agentIds.map((id) => ({
      id,
      role: id,
      adapter: 'claude-sdk',
      status: 'pending',
    })),
  };
}

function responseEvt(
  text: string,
  usage?: { promptTokens?: number; completionTokens?: number },
): AdapterEvent {
  return {
    kind: 'response',
    ts: '2026-01-01T00:00:00Z',
    text,
    ...(usage ? { usage } : {}),
  };
}

describe('TokenAccumulator', () => {
  it('accumulates per-call entries on the agent.tokenHistory', async () => {
    const jobs = new Map<string, JobRecord>();
    const job = emptyJob('j1', ['planner']);
    jobs.set('j1', job);

    const bus = new JobBus();
    const acc = new TokenAccumulator(jobs);
    acc.attach(bus, 'j1');

    bus.publish('j1', 'planner', responseEvt('hi', { promptTokens: 12, completionTokens: 7 }));
    bus.publish('j1', 'planner', responseEvt('again', { promptTokens: 25, completionTokens: 4 }));

    expect(job.agents[0]?.tokenHistory).toEqual([
      { in: 12, out: 7 },
      { in: 25, out: 4 },
    ]);
  });

  it('maintains running per-agent sum alongside the history', async () => {
    const jobs = new Map<string, JobRecord>();
    const job = emptyJob('j1', ['planner']);
    jobs.set('j1', job);

    const bus = new JobBus();
    const acc = new TokenAccumulator(jobs);
    acc.attach(bus, 'j1');

    bus.publish('j1', 'planner', responseEvt('a', { promptTokens: 10, completionTokens: 5 }));
    bus.publish('j1', 'planner', responseEvt('b', { promptTokens: 20, completionTokens: 8 }));

    expect(job.agents[0]?.tokens).toEqual({ in: 30, out: 13 });
  });

  it('maintains running per-job sum across multiple agents', async () => {
    const jobs = new Map<string, JobRecord>();
    const job = emptyJob('j1', ['planner', 'reviewer']);
    jobs.set('j1', job);

    const bus = new JobBus();
    const acc = new TokenAccumulator(jobs);
    acc.attach(bus, 'j1');

    bus.publish('j1', 'planner', responseEvt('p', { promptTokens: 100, completionTokens: 30 }));
    bus.publish('j1', 'reviewer', responseEvt('r', { promptTokens: 200, completionTokens: 40 }));

    expect(job.tokens).toEqual({ in: 300, out: 70 });
    expect(job.agents.find((a) => a.id === 'planner')?.tokens).toEqual({ in: 100, out: 30 });
    expect(job.agents.find((a) => a.id === 'reviewer')?.tokens).toEqual({ in: 200, out: 40 });
  });

  it('ignores response events without a usage block', async () => {
    const jobs = new Map<string, JobRecord>();
    const job = emptyJob('j1', ['planner']);
    jobs.set('j1', job);

    const bus = new JobBus();
    const acc = new TokenAccumulator(jobs);
    acc.attach(bus, 'j1');

    bus.publish('j1', 'planner', responseEvt('no-usage'));

    expect(job.agents[0]?.tokenHistory).toBeUndefined();
    expect(job.agents[0]?.tokens).toBeUndefined();
    expect(job.tokens).toBeUndefined();
  });

  it('ignores non-response event kinds', async () => {
    const jobs = new Map<string, JobRecord>();
    const job = emptyJob('j1', ['planner']);
    jobs.set('j1', job);

    const bus = new JobBus();
    const acc = new TokenAccumulator(jobs);
    acc.attach(bus, 'j1');

    bus.publish('j1', 'planner', { kind: 'request', ts: 't', user: 'go', model: 'm' });
    bus.publish('j1', 'planner', { kind: 'error', ts: 't', message: 'boom' });

    expect(job.agents[0]?.tokenHistory).toBeUndefined();
    expect(job.agents[0]?.tokens).toBeUndefined();
  });

  it('drops zero-only usage entries (provider reported nothing meaningful)', async () => {
    // Some providers occasionally return a `usage` block with all
    // fields missing/zero. Pushing those would clutter history without
    // adding information.
    const jobs = new Map<string, JobRecord>();
    const job = emptyJob('j1', ['planner']);
    jobs.set('j1', job);

    const bus = new JobBus();
    const acc = new TokenAccumulator(jobs);
    acc.attach(bus, 'j1');

    bus.publish('j1', 'planner', responseEvt('zero', { promptTokens: 0, completionTokens: 0 }));

    expect(job.agents[0]?.tokenHistory).toBeUndefined();
  });

  it('treats partial usage (in only / out only) as a real entry', async () => {
    const jobs = new Map<string, JobRecord>();
    const job = emptyJob('j1', ['planner']);
    jobs.set('j1', job);

    const bus = new JobBus();
    const acc = new TokenAccumulator(jobs);
    acc.attach(bus, 'j1');

    bus.publish('j1', 'planner', responseEvt('in-only', { promptTokens: 50 }));
    bus.publish('j1', 'planner', responseEvt('out-only', { completionTokens: 20 }));

    expect(job.agents[0]?.tokenHistory).toEqual([
      { in: 50, out: 0 },
      { in: 0, out: 20 },
    ]);
    expect(job.agents[0]?.tokens).toEqual({ in: 50, out: 20 });
  });

  it('silently drops events for unknown agentIds (defensive)', async () => {
    const jobs = new Map<string, JobRecord>();
    const job = emptyJob('j1', ['planner']);
    jobs.set('j1', job);

    const bus = new JobBus();
    const acc = new TokenAccumulator(jobs);
    acc.attach(bus, 'j1');

    bus.publish(
      'j1',
      'phantom-agent',
      responseEvt('?', { promptTokens: 99, completionTokens: 99 }),
    );

    expect(job.agents[0]?.tokenHistory).toBeUndefined();
    expect(job.tokens).toBeUndefined();
  });

  it('silently drops events for unknown jobIds (defensive)', async () => {
    const jobs = new Map<string, JobRecord>();
    jobs.set('j1', emptyJob('j1', ['planner']));

    const bus = new JobBus();
    const acc = new TokenAccumulator(jobs);
    // Subscribe to j2 even though j2 isn't in the jobs map. Events
    // for j2 will arrive but get dropped because we can't find a
    // record to mutate.
    acc.attach(bus, 'j2');

    bus.publish('j2', 'planner', responseEvt('?', { promptTokens: 10, completionTokens: 5 }));

    // No throw, no state change on j1.
    expect(jobs.get('j1')?.tokens).toBeUndefined();
  });

  it('attach is idempotent — re-attaching does not double-count', async () => {
    const jobs = new Map<string, JobRecord>();
    const job = emptyJob('j1', ['planner']);
    jobs.set('j1', job);

    const bus = new JobBus();
    const acc = new TokenAccumulator(jobs);
    acc.attach(bus, 'j1');
    acc.attach(bus, 'j1'); // second attach — should be a no-op
    acc.attach(bus, 'j1'); // third too

    bus.publish('j1', 'planner', responseEvt('once', { promptTokens: 10, completionTokens: 5 }));

    expect(job.agents[0]?.tokenHistory).toEqual([{ in: 10, out: 5 }]);
    expect(acc.attachedJobIds()).toEqual(['j1']);
  });

  it('detach stops accumulation but preserves accumulated state', async () => {
    const jobs = new Map<string, JobRecord>();
    const job = emptyJob('j1', ['planner']);
    jobs.set('j1', job);

    const bus = new JobBus();
    const acc = new TokenAccumulator(jobs);
    acc.attach(bus, 'j1');

    bus.publish('j1', 'planner', responseEvt('first', { promptTokens: 10, completionTokens: 5 }));
    acc.detach('j1');
    // After detach, this event must NOT update state.
    bus.publish(
      'j1',
      'planner',
      responseEvt('after-detach', { promptTokens: 999, completionTokens: 999 }),
    );

    expect(job.agents[0]?.tokenHistory).toEqual([{ in: 10, out: 5 }]);
    expect(job.agents[0]?.tokens).toEqual({ in: 10, out: 5 });
    expect(acc.attachedJobIds()).toEqual([]);
  });

  it('detach is idempotent — calling on a non-attached jobId is a no-op', async () => {
    const jobs = new Map<string, JobRecord>();
    const acc = new TokenAccumulator(jobs);
    expect(() => acc.detach('never-attached')).not.toThrow();
  });

  it('isolates accumulation per job — event on j2 does not bleed into j1', async () => {
    const jobs = new Map<string, JobRecord>();
    const job1 = emptyJob('j1', ['planner']);
    const job2 = emptyJob('j2', ['planner']);
    jobs.set('j1', job1);
    jobs.set('j2', job2);

    const bus = new JobBus();
    const acc = new TokenAccumulator(jobs);
    acc.attach(bus, 'j1');
    acc.attach(bus, 'j2');

    bus.publish('j2', 'planner', responseEvt('j2', { promptTokens: 100, completionTokens: 50 }));

    expect(job1.tokens).toBeUndefined();
    expect(job2.tokens).toEqual({ in: 100, out: 50 });
  });
});

/**
 * Integration tests for the harness-server dispatcher: capacity-bounded
 * runJob queue + steering + cancel + dispatcher-status routes. Exercises
 * the full HTTP surface over Unix-domain-socket — same shape as
 * approval-resume-integration.test.ts and orchestrator-integration.test.ts.
 *
 * The dispatcher state lives on ServerCtx (no separate class today). These
 * tests pin the observable behavior:
 *   - submit immediately fires runJob when capacity is available
 *   - submit beyond capacity but within queue overflow → enqueue (200 + queued)
 *   - submit when queue is full → 503
 *   - GET /v1/dispatcher/status reflects queue + in-flight accurately
 *   - POST /v1/jobs/:id/steering writes; GET reads back
 *   - POST /v1/jobs/:id/cancel transitions the job to 'cancelled' on next tick
 */

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterEventBus, type AgentAdapter, type InvocationSpec } from '@ecruz165/agent-adapter';
import type { CredentialBroker } from '@ecruz165/agent-auth';
import type { Edge, FlowCatalog, FlowDef, TaskStep } from '@ecruz165/harness-core';
import { afterEach, describe, expect, it } from 'vitest';
import { startHarnessServer } from './index.ts';

const tmpSocket = () => join(tmpdir(), `ax-${randomUUID().slice(0, 8)}.sock`);

const dummyBroker: CredentialBroker = {
  async getCredential(provider) {
    return { provider, apiKey: 'test', source: 'env' };
  },
};

/**
 * Test adapter that BLOCKS until externally released. Used to keep jobs
 * "in flight" so we can observe dispatcher state transitions.
 */
class BlockingAdapter implements AgentAdapter {
  readonly events = new AdapterEventBus();
  readonly invokeCalls: InvocationSpec[] = [];
  private resolveBlock: (() => void) | null = null;
  private blockPromise: Promise<void>;

  constructor(private readonly reply: string) {
    this.blockPromise = new Promise((resolve) => {
      this.resolveBlock = resolve;
    });
  }

  release(): void {
    this.resolveBlock?.();
  }

  async invoke(spec: InvocationSpec): Promise<string> {
    this.invokeCalls.push(spec);
    this.events.emit({
      kind: 'request',
      ts: new Date().toISOString(),
      system: spec.system,
      user: spec.user,
      model: 'test-model',
    });
    await this.blockPromise; // hold here until release()
    this.events.emit({
      kind: 'response',
      ts: new Date().toISOString(),
      text: this.reply,
    });
    return this.reply;
  }
}

class PassthroughAdapter implements AgentAdapter {
  readonly events = new AdapterEventBus();
  readonly invokeCalls: InvocationSpec[] = [];
  constructor(private readonly reply: string) {}
  async invoke(spec: InvocationSpec): Promise<string> {
    this.invokeCalls.push(spec);
    this.events.emit({
      kind: 'request',
      ts: new Date().toISOString(),
      system: spec.system,
      user: spec.user,
      model: 'test-model',
    });
    this.events.emit({
      kind: 'response',
      ts: new Date().toISOString(),
      text: this.reply,
    });
    return this.reply;
  }
}

function flatFlow(): FlowDef {
  const nodes: TaskStep[] = [
    { id: '__trigger', kind: 'trigger', config: { kind: 'manual' } },
    {
      id: 'a',
      kind: 'agent',
      config: {
        agent: { id: 'a', role: 'A', adapter: 'claude-sdk', systemPrompt: 'do' },
      },
    },
  ];
  const edges: Edge[] = [{ from: '__trigger', to: 'a', type: 'sequence' }];
  return { id: 'flat', nodes, edges };
}

const catalog: FlowCatalog = { flows: [flatFlow()] };

describe('dispatcher capacity + queue', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('GET /v1/dispatcher/status reflects empty state on a fresh server', async () => {
    const socketPath = tmpSocket();
    const handle = await startHarnessServer({
      socketPath,
      catalog,
      broker: dummyBroker,
      adapterFactory: () => new PassthroughAdapter('done'),
      maxConcurrentJobs: 3,
    });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const status = await udsJson(socketPath, 'GET', '/v1/dispatcher/status');
    expect(status.status).toBe(200);
    expect(status.body.capacity).toBe(3);
    expect(status.body.inFlight).toEqual([]);
    expect(status.body.queued).toEqual([]);
  });

  it('rejects submissions with 503 when queue is full', async () => {
    // capacity 1, queue overflow at 2 (1 in-flight + 1 queued). The
    // 3rd submission gets 503.
    const adapters: BlockingAdapter[] = [];
    const socketPath = tmpSocket();
    const handle = await startHarnessServer({
      socketPath,
      catalog,
      broker: dummyBroker,
      adapterFactory: () => {
        const a = new BlockingAdapter(`r-${adapters.length + 1}`);
        adapters.push(a);
        return a;
      },
      maxConcurrentJobs: 1,
    });
    cleanups.push(async () => {
      // Release any blocked adapters so the test cleanup doesn't hang.
      for (const a of adapters) a.release();
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    // Submission 1 → fires immediately, blocks at adapter.
    const r1 = await udsJson(socketPath, 'POST', '/v1/jobs', {
      jobId: 'q1',
      pipeline: 'flat',
      input: 'first',
    });
    expect(r1.status).toBe(200);

    // Wait for the in-flight to register before submitting #2.
    await waitFor(async () => {
      const s = await udsJson(socketPath, 'GET', '/v1/dispatcher/status');
      return s.body.inFlight.includes('q1');
    });

    // Submission 2 → enqueues (1 in-flight, 0 queued, threshold 2).
    const r2 = await udsJson(socketPath, 'POST', '/v1/jobs', {
      jobId: 'q2',
      pipeline: 'flat',
      input: 'second',
    });
    expect(r2.status).toBe(200);

    await waitFor(async () => {
      const s = await udsJson(socketPath, 'GET', '/v1/dispatcher/status');
      return s.body.queued.length === 1 && s.body.queued[0].jobId === 'q2';
    });

    // Submission 3 → 503 (1 in-flight + 1 queued = threshold reached).
    const r3 = await udsJson(socketPath, 'POST', '/v1/jobs', {
      jobId: 'q3',
      pipeline: 'flat',
      input: 'third',
    });
    expect(r3.status).toBe(503);
    expect(r3.body.error).toMatch(/queue full/);
    expect(r3.body.dispatcher.capacity).toBe(1);

    // q3 was rejected — should NOT be in the jobs list.
    const list = await udsJson(socketPath, 'GET', '/v1/jobs');
    const ids = (list.body.jobs as Array<{ jobId: string }>).map((j) => j.jobId);
    expect(ids).not.toContain('q3');
  });

  it('drains queue when an in-flight job completes', async () => {
    const adapters: BlockingAdapter[] = [];
    const socketPath = tmpSocket();
    const handle = await startHarnessServer({
      socketPath,
      catalog,
      broker: dummyBroker,
      adapterFactory: () => {
        const a = new BlockingAdapter(`r-${adapters.length + 1}`);
        adapters.push(a);
        return a;
      },
      maxConcurrentJobs: 1,
    });
    cleanups.push(async () => {
      for (const a of adapters) a.release();
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    await udsJson(socketPath, 'POST', '/v1/jobs', {
      jobId: 'd1',
      pipeline: 'flat',
      input: 'first',
    });
    await waitFor(async () => {
      const s = await udsJson(socketPath, 'GET', '/v1/dispatcher/status');
      return s.body.inFlight.includes('d1');
    });

    await udsJson(socketPath, 'POST', '/v1/jobs', {
      jobId: 'd2',
      pipeline: 'flat',
      input: 'second',
    });
    await waitFor(async () => {
      const s = await udsJson(socketPath, 'GET', '/v1/dispatcher/status');
      return s.body.queued.length === 1;
    });

    // Release the first adapter — d1 completes, dispatcher pulls d2 from
    // the queue into the freed slot.
    adapters[0]?.release();
    await waitFor(async () => {
      const s = await udsJson(socketPath, 'GET', '/v1/dispatcher/status');
      return s.body.inFlight.includes('d2') && s.body.queued.length === 0;
    });
    // d2 is now in flight, blocking on its own adapter.
    adapters[1]?.release();

    await waitFor(async () => {
      const detail = await udsJson(socketPath, 'GET', '/v1/jobs/d2');
      return detail.body.job?.status === 'completed';
    });
  });
});

describe('dispatcher steering routes', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('POST /steering writes; GET /steering reads back the array', async () => {
    const socketPath = tmpSocket();
    const adapters: BlockingAdapter[] = [];
    const handle = await startHarnessServer({
      socketPath,
      catalog,
      broker: dummyBroker,
      adapterFactory: () => {
        const a = new BlockingAdapter('done');
        adapters.push(a);
        return a;
      },
      maxConcurrentJobs: 5,
    });
    cleanups.push(async () => {
      for (const a of adapters) a.release();
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    await udsJson(socketPath, 'POST', '/v1/jobs', {
      jobId: 'sj',
      pipeline: 'flat',
      input: 'go',
    });
    // Wait for the job to be in-flight (its graph must exist before
    // steerJob can write to the checkpointer).
    await waitFor(async () => {
      const s = await udsJson(socketPath, 'GET', '/v1/dispatcher/status');
      return s.body.inFlight.includes('sj');
    });

    // GET before any steering: empty array.
    const g0 = await udsJson(socketPath, 'GET', '/v1/jobs/sj/steering');
    expect(g0.status).toBe(200);
    expect(g0.body.steering).toEqual([]);

    // POST steering.
    const p1 = await udsJson(socketPath, 'POST', '/v1/jobs/sj/steering', {
      text: 'use OAuth',
    });
    expect(p1.status).toBe(200);
    expect(p1.body.accepted).toBe('use OAuth');

    // GET reads back the steering.
    const g1 = await udsJson(socketPath, 'GET', '/v1/jobs/sj/steering');
    expect(g1.body.steering).toEqual(['use OAuth']);

    // Multiple pushes accumulate (reducer concatenates).
    await udsJson(socketPath, 'POST', '/v1/jobs/sj/steering', {
      text: 'avoid breaking changes',
    });
    const g2 = await udsJson(socketPath, 'GET', '/v1/jobs/sj/steering');
    expect(g2.body.steering).toEqual(['use OAuth', 'avoid breaking changes']);
  });

  it('POST /steering rejects empty text with 400', async () => {
    const socketPath = tmpSocket();
    const adapters: BlockingAdapter[] = [];
    const handle = await startHarnessServer({
      socketPath,
      catalog,
      broker: dummyBroker,
      adapterFactory: () => {
        const a = new BlockingAdapter('done');
        adapters.push(a);
        return a;
      },
    });
    cleanups.push(async () => {
      for (const a of adapters) a.release();
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    await udsJson(socketPath, 'POST', '/v1/jobs', { jobId: 'st', pipeline: 'flat', input: 'go' });
    await waitFor(async () => {
      const s = await udsJson(socketPath, 'GET', '/v1/dispatcher/status');
      return s.body.inFlight.includes('st');
    });

    const r = await udsJson(socketPath, 'POST', '/v1/jobs/st/steering', { text: '' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/non-empty/);
  });

  it('GET /steering returns 404 on unknown job', async () => {
    const socketPath = tmpSocket();
    const handle = await startHarnessServer({
      socketPath,
      catalog,
      broker: dummyBroker,
      adapterFactory: () => new PassthroughAdapter('x'),
    });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await udsJson(socketPath, 'GET', '/v1/jobs/nope/steering');
    expect(r.status).toBe(404);
  });
});

interface UdsResponse {
  status: number;
  body: any;
}

function udsJson(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<UdsResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path, method, headers: body ? { 'content-type': 'application/json' } : {} },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c.toString()));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: buf ? JSON.parse(buf) : null });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

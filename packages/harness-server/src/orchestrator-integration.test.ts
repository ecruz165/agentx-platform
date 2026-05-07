import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterEventBus, type AgentAdapter, type InvocationSpec } from '@ecruz165/agent-adapter';
import type { CredentialBroker } from '@ecruz165/agent-auth';
import type { AdapterId, PipelineCatalog } from '@ecruz165/harness-core';
import { afterEach, describe, expect, it } from 'vitest';
import { startHarnessServer } from './index.ts';

const tmpSocket = () => join(tmpdir(), `ax-${randomUUID().slice(0, 8)}.sock`);

const dummyBroker: CredentialBroker = {
  async getCredential(provider) {
    return { provider, apiKey: 'test', source: 'env' };
  },
};

/** Test adapter that emits a request → response cycle and returns a fixed text. */
class TestAdapter implements AgentAdapter {
  readonly events = new AdapterEventBus();
  invokeCalls: InvocationSpec[] = [];

  constructor(
    private readonly behavior:
      | { kind: 'ok'; reply: string; usage?: { promptTokens?: number; completionTokens?: number } }
      | { kind: 'throw'; message: string },
  ) {}

  async invoke(spec: InvocationSpec): Promise<string> {
    this.invokeCalls.push(spec);
    this.events.emit({
      kind: 'request',
      ts: new Date().toISOString(),
      system: spec.system,
      user: spec.user,
      model: 'test-model',
    });
    if (this.behavior.kind === 'throw') {
      this.events.emit({
        kind: 'error',
        ts: new Date().toISOString(),
        message: this.behavior.message,
      });
      throw new Error(this.behavior.message);
    }
    this.events.emit({
      kind: 'response',
      ts: new Date().toISOString(),
      text: this.behavior.reply,
      ...(this.behavior.usage ? { usage: this.behavior.usage } : {}),
    });
    return this.behavior.reply;
  }
}

const sampleCatalog: PipelineCatalog = {
  pipelines: [
    {
      id: 'feature-add',
      agents: [
        { id: 'planner', role: 'Plan', adapter: 'claude-sdk', systemPrompt: 'plan it' },
        { id: 'implementer', role: 'Implement', adapter: 'claude-sdk', systemPrompt: 'build it' },
        { id: 'reviewer', role: 'Review', adapter: 'claude-sdk', systemPrompt: 'review it' },
      ],
    },
  ],
};

describe('orchestrator wired into POST /v1/jobs', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('drives a job to completion in the background after submit', async () => {
    const socketPath = tmpSocket();
    const factoryCalls: AdapterId[] = [];
    const handle = await startHarnessServer({
      socketPath,
      catalog: sampleCatalog,
      broker: dummyBroker,
      adapterFactory: (id) => {
        factoryCalls.push(id);
        return new TestAdapter({ kind: 'ok', reply: `out-${factoryCalls.length}` });
      },
    });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const submit = await udsJson(socketPath, 'POST', '/v1/jobs', {
      jobId: 'j1',
      pipeline: 'feature-add',
      input: 'do the thing',
    });
    expect(submit.body.ok).toBe(true);
    // Submit responds before runJob completes.
    expect(submit.body.job.status).toBe('received');

    // Wait for orchestrator to finish.
    await waitFor(async () => {
      const detail = await udsJson(socketPath, 'GET', '/v1/jobs/j1');
      return detail.body.job.status === 'completed';
    });

    const detail = await udsJson(socketPath, 'GET', '/v1/jobs/j1');
    expect(detail.body.job.status).toBe('completed');
    const statuses = (detail.body.job.agents as Array<{ id: string; status: string }>).map(
      (a) => `${a.id}=${a.status}`,
    );
    // Both synthetic coordinators stay pending (skipped — they're
    // placeholders today); pipeline agents run to completed.
    expect(statuses).toEqual([
      'coordinator=pending',
      'planner=completed',
      'implementer=completed',
      'reviewer=completed',
      'checkout-coordinator=pending',
    ]);

    // Each pipeline agent triggered the factory.
    expect(factoryCalls).toHaveLength(3);
  });

  it('aggregates per-agent + per-job tokens onto the JobRecord (slice 13d)', async () => {
    const socketPath = tmpSocket();
    let factoryIndex = 0;
    // Each agent reports distinct usage so we can verify the per-agent
    // numbers stay separate AND the job total sums correctly.
    const usagesByOrder = [
      { promptTokens: 100, completionTokens: 30 }, // planner
      { promptTokens: 200, completionTokens: 40 }, // implementer
      { promptTokens: 300, completionTokens: 50 }, // reviewer
    ];
    const handle = await startHarnessServer({
      socketPath,
      catalog: sampleCatalog,
      broker: dummyBroker,
      adapterFactory: () => {
        const usage = usagesByOrder[factoryIndex++];
        return new TestAdapter({
          kind: 'ok',
          reply: `out-${factoryIndex}`,
          ...(usage ? { usage } : {}),
        });
      },
    });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    await udsJson(socketPath, 'POST', '/v1/jobs', {
      jobId: 'j-tokens',
      pipeline: 'feature-add',
      input: 'measure me',
    });

    await waitFor(async () => {
      const detail = await udsJson(socketPath, 'GET', '/v1/jobs/j-tokens');
      return detail.body.job.status === 'completed';
    });

    const detail = await udsJson(socketPath, 'GET', '/v1/jobs/j-tokens');
    const job = detail.body.job as {
      tokens?: { in: number; out: number };
      agents: Array<{
        id: string;
        tokens?: { in: number; out: number };
        tokenHistory?: Array<{ in: number; out: number }>;
      }>;
    };

    // Per-job total = sum of per-agent totals.
    expect(job.tokens).toEqual({ in: 600, out: 120 });

    // Per-agent breakdown.
    const planner = job.agents.find((a) => a.id === 'planner');
    const implementer = job.agents.find((a) => a.id === 'implementer');
    const reviewer = job.agents.find((a) => a.id === 'reviewer');
    expect(planner?.tokens).toEqual({ in: 100, out: 30 });
    expect(implementer?.tokens).toEqual({ in: 200, out: 40 });
    expect(reviewer?.tokens).toEqual({ in: 300, out: 50 });

    // Per-call history (one entry per response event with usage).
    expect(planner?.tokenHistory).toEqual([{ in: 100, out: 30 }]);
    expect(implementer?.tokenHistory).toEqual([{ in: 200, out: 40 }]);
    expect(reviewer?.tokenHistory).toEqual([{ in: 300, out: 50 }]);

    // Synthetic coordinators are skipped — they never emitted, so their
    // token fields stay undefined.
    const coord = job.agents.find((a) => a.id === 'coordinator');
    expect(coord?.tokens).toBeUndefined();
    expect(coord?.tokenHistory).toBeUndefined();
  });

  it('leaves token fields undefined when adapters never report usage', async () => {
    const socketPath = tmpSocket();
    const handle = await startHarnessServer({
      socketPath,
      catalog: sampleCatalog,
      broker: dummyBroker,
      adapterFactory: () => new TestAdapter({ kind: 'ok', reply: 'silent' }),
    });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    await udsJson(socketPath, 'POST', '/v1/jobs', {
      jobId: 'j-no-usage',
      pipeline: 'feature-add',
      input: 'silent',
    });

    await waitFor(async () => {
      const detail = await udsJson(socketPath, 'GET', '/v1/jobs/j-no-usage');
      return detail.body.job.status === 'completed';
    });

    const detail = await udsJson(socketPath, 'GET', '/v1/jobs/j-no-usage');
    const job = detail.body.job;
    expect(job.tokens).toBeUndefined();
    for (const a of job.agents) {
      expect(a.tokens).toBeUndefined();
      expect(a.tokenHistory).toBeUndefined();
    }
  });

  it('without a broker, registration succeeds but agents never leave pending', async () => {
    const socketPath = tmpSocket();
    const handle = await startHarnessServer({ socketPath, catalog: sampleCatalog });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    await udsJson(socketPath, 'POST', '/v1/jobs', {
      jobId: 'j-no-broker',
      pipeline: 'feature-add',
      input: 'idle',
    });

    // Give any potential async orchestrator a chance to fire.
    await new Promise((r) => setTimeout(r, 50));

    const detail = await udsJson(socketPath, 'GET', '/v1/jobs/j-no-broker');
    expect(detail.body.job.status).toBe('received');
    for (const a of detail.body.job.agents) {
      expect(a.status).toBe('pending');
    }
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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1_500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

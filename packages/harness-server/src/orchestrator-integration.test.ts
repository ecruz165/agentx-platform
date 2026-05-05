import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AdapterEventBus,
  type AgentAdapter,
  type InvocationSpec,
} from '@agentx/agent-adapter';
import type { CredentialBroker } from '@agentx/agent-auth-lib';
import type { AdapterId, PipelineCatalog } from '@agentx/harness-core';
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
      | { kind: 'ok'; reply: string }
      | { kind: 'throw'; message: string }
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
      (a) => `${a.id}=${a.status}`
    );
    // Coordinator stays pending (skipped); pipeline agents run to completed.
    expect(statuses).toEqual([
      'coordinator=pending',
      'planner=completed',
      'implementer=completed',
      'reviewer=completed',
    ]);

    // Each pipeline agent triggered the factory.
    expect(factoryCalls).toHaveLength(3);
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
  body?: unknown
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
      }
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

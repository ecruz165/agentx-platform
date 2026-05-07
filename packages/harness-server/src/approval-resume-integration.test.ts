/**
 * End-to-end integration test for the HITL Approval round-trip over HTTP.
 *
 * Exercises the full path: POST /v1/jobs (with an Approval-tagged flow) →
 * job pauses at 'awaiting-approval' → GET /v1/jobs/:id/approval returns
 * the request payload → POST /v1/jobs/:id/resume with {decision: 'approve'}
 * → job runs to 'completed'. Also verifies the reject-then-approve cycle
 * (rejection re-runs the inner agent with steering context, then a final
 * approve completes).
 *
 * Differs from orchestrator-integration.test.ts: that file pins the
 * non-paused submit path. This file pins the paused/resumable path —
 * specifically the ServerCtx state machinery (pendingApprovals map, graphs
 * cache, hook wiring) plus the new HTTP routes.
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

class TestAdapter implements AgentAdapter {
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

/** Build an approval-tagged 2-step flow: planner (Approval) → builder. */
function approvalFlow(): FlowDef {
  const nodes: TaskStep[] = [
    { id: '__trigger', kind: 'trigger', config: { kind: 'manual' } },
    {
      id: 'planner',
      kind: 'agent',
      config: {
        agent: {
          id: 'planner',
          role: 'Plan',
          adapter: 'claude-sdk',
          systemPrompt: 'plan',
        },
      },
      tags: {
        approval: {
          assigneeRole: 'tech-lead',
          slaMs: 60_000,
          concurrency: 'pessimistic',
        },
      },
    },
    {
      id: 'builder',
      kind: 'agent',
      config: {
        agent: {
          id: 'builder',
          role: 'Build',
          adapter: 'claude-sdk',
          systemPrompt: 'build',
        },
      },
    },
  ];
  const edges: Edge[] = [
    { from: '__trigger', to: 'planner', type: 'sequence' },
    { from: 'planner', to: 'builder', type: 'sequence' },
    // Self-loop on reject: planner re-runs with steering injected.
    { from: 'planner', to: 'planner', type: 'reject', maxAttempts: 3 },
  ];
  return { id: 'plan-then-build', nodes, edges };
}

const catalog: FlowCatalog = { flows: [approvalFlow()] };

describe('HITL Approval round-trip over HTTP', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('pauses on submit, surfaces ApprovalRequest, resumes on approve, completes', async () => {
    const socketPath = tmpSocket();
    const adapters: TestAdapter[] = [];
    const handle = await startHarnessServer({
      socketPath,
      catalog,
      broker: dummyBroker,
      adapterFactory: () => {
        const a = new TestAdapter(`reply-${adapters.length + 1}`);
        adapters.push(a);
        return a;
      },
    });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    // Submit a job that will pause at the Approval-tagged planner.
    const submit = await udsJson(socketPath, 'POST', '/v1/jobs', {
      jobId: 'jApprove',
      pipeline: 'plan-then-build',
      input: 'design the auth module',
    });
    expect(submit.status).toBe(200);
    expect(submit.body.job.status).toBe('received');

    // Wait for the orchestrator to reach 'awaiting-approval'.
    await waitFor(async () => {
      const r = await udsJson(socketPath, 'GET', '/v1/jobs/jApprove');
      return r.body.job?.status === 'awaiting-approval';
    });

    // Planner ran (1 adapter invocation); builder did NOT.
    expect(adapters).toHaveLength(1);
    expect(adapters[0]?.invokeCalls).toHaveLength(1);

    // Fetch the pending approval payload.
    const approval = await udsJson(socketPath, 'GET', '/v1/jobs/jApprove/approval');
    expect(approval.status).toBe(200);
    expect(approval.body.request.kind).toBe('approval');
    expect(approval.body.request.nodeId).toBe('planner');
    expect(approval.body.request.assigneeRole).toBe('tech-lead');
    expect(approval.body.request.content).toBe('reply-1');
    expect(approval.body.request.attempt).toBe(1);

    // Approve.
    const resume = await udsJson(socketPath, 'POST', '/v1/jobs/jApprove/resume', {
      decision: 'approve',
    });
    expect(resume.status).toBe(200);
    expect(resume.body.accepted).toBe('approval');

    // Job runs to completion. builder now ran.
    await waitFor(async () => {
      const r = await udsJson(socketPath, 'GET', '/v1/jobs/jApprove');
      return r.body.job?.status === 'completed';
    });

    // 1 planner invocation (NOT re-run on resume — synthetic node owns
    // the interrupt) + 1 builder invocation.
    expect(adapters).toHaveLength(2);
    // After completion, the pending-approval entry is cleared.
    const after = await udsJson(socketPath, 'GET', '/v1/jobs/jApprove/approval');
    expect(after.status).toBe(404);
  });

  it('routes via reject edge on resume with reject; re-runs planner; then approves', async () => {
    const socketPath = tmpSocket();
    const adapters: TestAdapter[] = [];
    const handle = await startHarnessServer({
      socketPath,
      catalog,
      broker: dummyBroker,
      adapterFactory: () => {
        const a = new TestAdapter(`reply-${adapters.length + 1}`);
        adapters.push(a);
        return a;
      },
    });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    await udsJson(socketPath, 'POST', '/v1/jobs', {
      jobId: 'jReject',
      pipeline: 'plan-then-build',
      input: 'design the auth module',
    });
    await waitFor(async () => {
      const r = await udsJson(socketPath, 'GET', '/v1/jobs/jReject');
      return r.body.job?.status === 'awaiting-approval';
    });
    expect(adapters).toHaveLength(1); // planner ran

    // Reject with steering — planner cycles back, runs again, pauses again.
    const r1 = await udsJson(socketPath, 'POST', '/v1/jobs/jReject/resume', {
      decision: 'reject',
      steering: 'consider OAuth instead of JWT',
    });
    expect(r1.status).toBe(200);

    await waitFor(async () => {
      const r = await udsJson(socketPath, 'GET', '/v1/jobs/jReject');
      return (
        r.body.job?.status === 'awaiting-approval' &&
        // Wait until the planner re-ran (second adapter constructed).
        adapters.length === 2
      );
    });
    expect(adapters).toHaveLength(2); // planner re-ran on reject

    // Second approval request reflects the increment + steering reached
    // the planner via state.rejectionPayload.steering. The harness
    // doesn't currently echo steering into the system prompt
    // automatically — the agent receives it on state for its own use.
    const approval2 = await udsJson(socketPath, 'GET', '/v1/jobs/jReject/approval');
    expect(approval2.body.request.attempt).toBe(2);
    expect(approval2.body.request.content).toBe('reply-2');

    // Approve the second draft.
    await udsJson(socketPath, 'POST', '/v1/jobs/jReject/resume', {
      decision: 'approve',
    });
    await waitFor(async () => {
      const r = await udsJson(socketPath, 'GET', '/v1/jobs/jReject');
      return r.body.job?.status === 'completed';
    });
    // 2 planner runs + 1 builder run.
    expect(adapters).toHaveLength(3);
  });

  it('rejects resume on a job that is not paused (status: completed) with 400', async () => {
    // Use a flow with no Approval tag — completes synchronously.
    const flatCatalog: FlowCatalog = {
      flows: [
        {
          id: 'flat',
          nodes: [
            { id: '__trigger', kind: 'trigger', config: { kind: 'manual' } },
            {
              id: 'a',
              kind: 'agent',
              config: {
                agent: {
                  id: 'a',
                  role: 'A',
                  adapter: 'claude-sdk',
                  systemPrompt: 'do',
                },
              },
            },
          ],
          edges: [{ from: '__trigger', to: 'a', type: 'sequence' }],
        },
      ],
    };
    const socketPath = tmpSocket();
    const handle = await startHarnessServer({
      socketPath,
      catalog: flatCatalog,
      broker: dummyBroker,
      adapterFactory: () => new TestAdapter('done'),
    });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    await udsJson(socketPath, 'POST', '/v1/jobs', {
      jobId: 'jFlat',
      pipeline: 'flat',
      input: 'go',
    });
    await waitFor(async () => {
      const r = await udsJson(socketPath, 'GET', '/v1/jobs/jFlat');
      return r.body.job?.status === 'completed';
    });

    const resume = await udsJson(socketPath, 'POST', '/v1/jobs/jFlat/resume', {
      decision: 'approve',
    });
    expect(resume.status).toBe(400);
    expect(resume.body.error).toMatch(/not paused/);
  });

  it('returns 404 from GET /v1/jobs/:id/approval when the job has no pending request', async () => {
    const socketPath = tmpSocket();
    const handle = await startHarnessServer({
      socketPath,
      catalog,
      broker: dummyBroker,
      adapterFactory: () => new TestAdapter('x'),
    });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await udsJson(socketPath, 'GET', '/v1/jobs/nope/approval');
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

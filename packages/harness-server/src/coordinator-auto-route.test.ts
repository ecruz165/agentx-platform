/**
 * Tests for the entry-coordinator auto-routing path on POST /v1/jobs.
 *
 * Per memory project_langgraph_two_scopes — coordinator workflows are
 * admin-owned and run inside harness-server. When a submission omits
 * `pipeline` AND a coordinatorModel is configured AND the submission
 * has an `input` (intent), the server runs the entry-coord graph to
 * pick a pipeline before responding.
 *
 * Coverage:
 *   - intent-only submission with stub model → response carries picked pipeline id
 *   - registered job has the picked pipeline's agents (incl. coordinators)
 *   - "NONE" decision → 400 with actionable message
 *   - hallucinated pipeline (not in catalog) → 400 with actionable message
 *   - explicit `pipeline` field bypasses coordinator (back-compat)
 *   - no coordinator model configured → falls back to placeholder behavior
 *   - coordinator throws → 400 surfaces the error
 */

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDef, Edge, FlowCatalog, FlowDef, TaskStep } from '@ecruz165/harness-core';
import { SimpleChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { afterEach, describe, expect, it } from 'vitest';
import { type HarnessServerHandle, startHarnessServer } from './index.ts';

/** Test helper: build a linear flow from a list of AgentDefs.
 *  trigger → agents[0] → agents[1] → ... */
function flowFromAgents(id: string, description: string | undefined, agents: AgentDef[]): FlowDef {
  const triggerId = '__trigger';
  const nodes: TaskStep[] = [
    { id: triggerId, kind: 'trigger', config: { kind: 'manual' } },
    ...agents.map((a): TaskStep => ({ id: a.id, kind: 'agent', config: { agent: a } })),
  ];
  const edges: Edge[] = [];
  let prev = triggerId;
  for (const a of agents) {
    edges.push({ from: prev, to: a.id, type: 'sequence' });
    prev = a.id;
  }
  return description !== undefined ? { id, description, nodes, edges } : { id, nodes, edges };
}
const tmpSocket = () => join(tmpdir(), `ax-${randomUUID().slice(0, 8)}.sock`);

interface UdsResponse {
  status: number;
  body: { error?: string; job?: { jobId?: string; pipeline?: string; agents?: { id: string }[] } };
}

function udsRequest(
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

class StubChatModel extends SimpleChatModel {
  constructor(private readonly response: string) {
    super({});
  }
  _llmType(): string {
    return 'stub';
  }
  async _call(_msgs: BaseMessage[]): Promise<string> {
    if (this.response.startsWith('THROW:')) {
      throw new Error(this.response.slice('THROW:'.length));
    }
    return this.response;
  }
}

const catalog: FlowCatalog = {
  flows: [
    flowFromAgents('feature-add', 'plan, build, review for new features', [
      { id: 'planner', role: 'Plan', adapter: 'claude-sdk' },
    ]),
    flowFromAgents('bugfix-triage', 'reproduce, fix, test bugs', [
      { id: 'reproducer', role: 'Repro', adapter: 'claude-sdk' },
    ]),
  ],
};

describe('handleSubmitJob — entry coordinator auto-routing', () => {
  let handle: HarnessServerHandle | null = null;
  const sockets: string[] = [];

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = null;
    }
    for (const s of sockets) await rm(s, { force: true }).catch(() => {});
    sockets.length = 0;
  });

  async function startServer(coordinatorModel?: SimpleChatModel): Promise<string> {
    const socket = tmpSocket();
    sockets.push(socket);
    handle = await startHarnessServer({
      socketPath: socket,
      catalog,
      ...(coordinatorModel ? { coordinatorModel } : {}),
    });
    return socket;
  }

  it('auto-routes intent-only submission via coordinator and returns picked pipeline', async () => {
    const socket = await startServer(new StubChatModel('bugfix-triage'));
    const res = await udsRequest(socket, 'POST', '/v1/jobs', {
      jobId: 'j1',
      input: 'login throws 500 on special chars',
    });
    expect(res.status).toBe(200);
    expect(res.body.job?.pipeline).toBe('bugfix-triage');
    // Job should have coordinator + reproducer + checkout-coordinator
    const agentIds = res.body.job?.agents?.map((a) => a.id);
    expect(agentIds).toEqual(['coordinator', 'reproducer', 'checkout-coordinator']);
  });

  it('returns 400 when coordinator picks "NONE"', async () => {
    const socket = await startServer(new StubChatModel('NONE'));
    const res = await udsRequest(socket, 'POST', '/v1/jobs', {
      jobId: 'j2',
      input: 'launch a rocket',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/coordinator could not pick a valid pipeline/);
    expect(res.body.error).toMatch(/NONE/);
  });

  it('returns 400 when coordinator picks a pipeline not in the catalog', async () => {
    const socket = await startServer(new StubChatModel('hallucinated-pipeline'));
    const res = await udsRequest(socket, 'POST', '/v1/jobs', {
      jobId: 'j3',
      input: 'do something',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/coordinator could not pick a valid pipeline/);
    expect(res.body.error).toMatch(/hallucinated-pipeline/);
  });

  it('explicit `pipeline` bypasses coordinator (back-compat path)', async () => {
    // Even though coordinator would route somewhere, an explicit pipeline
    // takes precedence — coordinator never runs.
    const stubThatWouldFail = new StubChatModel('THROW:should-not-be-called');
    const socket = await startServer(stubThatWouldFail);
    const res = await udsRequest(socket, 'POST', '/v1/jobs', {
      jobId: 'j4',
      input: 'add a feature',
      pipeline: 'feature-add',
    });
    expect(res.status).toBe(200);
    expect(res.body.job?.pipeline).toBe('feature-add');
  });

  it('no coordinator model configured + intent-only → falls back to placeholder behavior', async () => {
    // Pre-10c behavior: server registers only the coordinator placeholder
    // when no pipeline is given.
    const socket = await startServer(/* no coordinatorModel */);
    const res = await udsRequest(socket, 'POST', '/v1/jobs', {
      jobId: 'j5',
      input: 'do anything',
    });
    expect(res.status).toBe(200);
    expect(res.body.job?.pipeline).toBeUndefined();
    expect(res.body.job?.agents?.map((a) => a.id)).toEqual(['coordinator']);
  });

  it('coordinator throws → 400 with actionable message', async () => {
    const socket = await startServer(new StubChatModel('THROW:network down'));
    const res = await udsRequest(socket, 'POST', '/v1/jobs', {
      jobId: 'j6',
      input: 'do stuff',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/coordinator routing failed/);
    expect(res.body.error).toMatch(/network down/);
  });

  it('intent-only submission with NO input field skips coordinator (no signal to route on)', async () => {
    // Submission without `input` and no `pipeline` — the coordinator
    // can't route on nothing. Falls back to placeholder behavior.
    const socket = await startServer(new StubChatModel('THROW:should-not-be-called'));
    const res = await udsRequest(socket, 'POST', '/v1/jobs', {
      jobId: 'j7',
    });
    expect(res.status).toBe(200);
    expect(res.body.job?.agents?.map((a) => a.id)).toEqual(['coordinator']);
  });
});

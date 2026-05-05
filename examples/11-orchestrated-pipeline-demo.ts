import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdapterEventBus,
  type AdapterEvent,
  type AgentAdapter,
  type InvocationSpec,
} from '@agentx/agent-adapter';
import type { CredentialBroker } from '@agentx/agent-auth-lib';
import {
  startHarnessServer,
  type AdapterFactory,
  type Envelope,
  type PipelineCatalog,
} from '@agentx/harness-server';

/**
 * Phase 6 demo — full chain end-to-end without API keys:
 *
 *   1. Boot harness-server with catalog + broker + mock adapter factory.
 *   2. POST a job.
 *   3. Orchestrator runs in the background: walks agents, invokes mock
 *      adapters, threads outputs, updates statuses.
 *   4. SSE client (also us, in this script) sees request/response events
 *      stream live as each agent runs.
 *   5. After completion, GET /v1/jobs/:id confirms all agents are 'completed'.
 *
 * The mock adapter factory returns adapters that emit a request/response cycle
 * with a deterministic reply — so this demo exercises the orchestrator without
 * any network or credentials.
 */

const sockDir = mkdtempSync(join(tmpdir(), 'ax-orch-'));
const socketPath = join(sockDir, 's.sock');

const catalog: PipelineCatalog = {
  pipelines: [
    {
      id: 'feature-add',
      agents: [
        { id: 'planner', role: 'Plan', adapter: 'claude-sdk', systemPrompt: 'Plan the work.' },
        { id: 'implementer', role: 'Implement', adapter: 'claude-sdk', systemPrompt: 'Implement the plan.' },
        { id: 'reviewer', role: 'Review', adapter: 'claude-sdk', systemPrompt: 'Review the changes.' },
      ],
    },
  ],
};

class MockAdapter implements AgentAdapter {
  readonly events = new AdapterEventBus();
  constructor(private readonly reply: (user: string) => string) {}

  async invoke(spec: InvocationSpec): Promise<string> {
    this.events.emit({
      kind: 'request',
      ts: new Date().toISOString(),
      system: spec.system,
      user: spec.user,
      model: 'mock',
    });
    // Simulate latency so events arrive at the SSE client one at a time.
    await new Promise((r) => setTimeout(r, 80));
    const text = this.reply(spec.user);
    this.events.emit({
      kind: 'response',
      ts: new Date().toISOString(),
      text,
    });
    return text;
  }
}

const replyFor: Record<string, (user: string) => string> = {
  Plan: () => '1. Pick a button name. 2. Wire onClick. 3. Add a unit test.',
  Implement: (plan) => `wrote button.tsx + button.test.tsx (plan was: "${plan.slice(0, 30)}…")`,
  Review: (impl) => `LGTM — nit: rename onClick handler. (saw: "${impl.slice(0, 30)}…")`,
};

// The factory is called per-agent in declaration order. The signature only
// gives us the adapter id, not the agent role — we close over a counter to
// pick the right canned reply for each pipeline position.
let factoryCallIdx = 0;
const factory: AdapterFactory = () => {
  const role = ['Plan', 'Implement', 'Review'][factoryCallIdx++]!;
  return new MockAdapter(replyFor[role]!);
};

const dummyBroker: CredentialBroker = {
  async getCredential(provider) {
    return { provider, apiKey: 'test', source: 'env' };
  },
};

console.log('▶ Starting harness-server with catalog + broker + mock factory…');
const handle = await startHarnessServer({
  socketPath,
  catalog,
  broker: dummyBroker,
  adapterFactory: factory,
});
console.log(`  ✓ listening on ${socketPath}\n`);

try {
  const jobId = 'job-orch-1';

  // Open SSE stream BEFORE submitting so we don't miss the orchestrator's
  // first events (orchestrator runs in queueMicrotask after the response).
  console.log(`▶ Opening SSE: GET /v1/jobs/${jobId}/events`);
  const seen: Envelope[] = [];
  const closeSse = openSseStream(socketPath, `/v1/jobs/${jobId}/events`, (env) => {
    seen.push(env);
    const e = env.event;
    const preview =
      e.kind === 'request'
        ? truncate(e.user, 60)
        : e.kind === 'response'
          ? truncate(e.text, 60)
          : e.kind === 'error'
            ? e.message
            : '';
    console.log(`  ← ${env.agentId.padEnd(14)} ${e.kind.padEnd(8)} ${preview}`);
  });
  await waitFor(() => handle.bus.subscriberCount(jobId) === 1);
  console.log(`  ✓ subscribed\n`);

  console.log('▶ POST /v1/jobs (orchestrator runs in background)\n');
  const submit = await udsJson('POST', '/v1/jobs', {
    jobId,
    pipeline: 'feature-add',
    productId: 'demo',
    input: 'Add a button',
  });
  console.log(`  ✓ submit returned: status=${submit.body.job.status}`);
  console.log('  agents at submit time (all pending):');
  for (const a of submit.body.job.agents) {
    console.log(`    • ${a.id.padEnd(14)} ${a.status}`);
  }
  console.log();

  // Wait for orchestrator to finish.
  await waitFor(async () => {
    const detail = await udsJson('GET', `/v1/jobs/${jobId}`);
    return detail.body.job.status === 'completed' || detail.body.job.status === 'failed';
  }, 5_000);

  const detail = await udsJson('GET', `/v1/jobs/${jobId}`);
  console.log(`\n▶ Final state: job=${detail.body.job.status}`);
  for (const a of detail.body.job.agents) {
    console.log(`    • ${a.id.padEnd(14)} ${a.status}`);
  }
  console.log();

  closeSse();
  await waitFor(() => handle.bus.subscriberCount(jobId) === 0);

  console.log(`✓ Demo complete — ${seen.length} envelopes streamed; orchestrator drove pipeline to completion.`);
} finally {
  await handle.stop();
  rmSync(sockDir, { recursive: true, force: true });
}

interface UdsResponse {
  status: number;
  body: any;
}

function udsJson(method: string, path: string, body?: unknown): Promise<UdsResponse> {
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

function openSseStream(
  socketPath: string,
  path: string,
  onEnvelope: (env: Envelope) => void
): () => void {
  let buffer = '';
  let closed = false;
  let received = false;

  const req = request({ socketPath, path, method: 'GET' }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      received = true;
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              onEnvelope(JSON.parse(line.slice(6)) as Envelope);
            } catch {
              // skip malformed
            }
          }
        }
      }
    });
  });
  req.on('error', (err: NodeJS.ErrnoException) => {
    if (closed && received && err.code === 'ECONNRESET') return;
    if (!closed) console.error('SSE error:', err.message);
  });
  req.end();

  return () => {
    if (closed) return;
    closed = true;
    req.destroy();
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// Silence unused-import warning if AdapterEvent gets pruned by tooling
void (null as unknown as AdapterEvent);

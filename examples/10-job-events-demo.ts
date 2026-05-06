import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Envelope, type PipelineCatalog, startHarnessServer } from '@agentx/harness-server';

/**
 * End-to-end demo of the Phase 0–5 event flow.
 *
 *   1. Boot harness-server with an inline pipeline catalog.
 *   2. POST a job → server registers [coordinator, planner, implementer, reviewer].
 *   3. GET the registered agents back.
 *   4. Open a streaming SSE connection to /v1/jobs/:id/events.
 *   5. Publish synthetic envelopes onto the bus to simulate agent activity.
 *   6. The SSE client prints them as they arrive.
 *   7. Clean shutdown.
 *
 * No API keys required — we don't call real adapters here, just the bus.
 * This is the pure event-plane smoke test.
 */

const sockDir = mkdtempSync(join(tmpdir(), 'ax-demo-'));
const socketPath = join(sockDir, 's.sock');

const catalog: PipelineCatalog = {
  pipelines: [
    {
      id: 'feature-add',
      description: 'plan, implement, review',
      agents: [
        { id: 'planner', role: 'Plan', adapter: 'claude-sdk', systemPrompt: 'plan things' },
        {
          id: 'implementer',
          role: 'Implement',
          adapter: 'claude-sdk',
          systemPrompt: 'build things',
        },
        { id: 'reviewer', role: 'Review', adapter: 'claude-sdk', systemPrompt: 'review things' },
      ],
    },
  ],
};

console.log('▶ Starting harness-server with inline catalog…');
const handle = await startHarnessServer({ socketPath, catalog });
console.log(`  ✓ listening on ${socketPath}\n`);

try {
  const jobId = 'job-demo-1';

  // 1) Submit a job
  console.log('▶ POST /v1/jobs (pipeline: feature-add)');
  const submit = await udsJson('POST', '/v1/jobs', {
    jobId,
    pipeline: 'feature-add',
    productId: 'demo',
    input: 'Add a small feature.',
  });
  console.log(`  ✓ status=${submit.body.job.status}`);
  console.log(`    agents registered:`);
  for (const a of submit.body.job.agents) {
    console.log(
      `      • ${a.id.padEnd(14)} role=${a.role.padEnd(11)} adapter=${a.adapter}  status=${a.status}`,
    );
  }
  console.log();

  // 2) GET agents (round-trip the registered list)
  console.log(`▶ GET /v1/jobs/${jobId}/agents`);
  const agents = await udsJson('GET', `/v1/jobs/${jobId}/agents`);
  console.log(`  ✓ ${agents.body.agents.length} agents returned\n`);

  // 3) Open SSE stream
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

  // Give the server a moment to register the SSE subscription
  await waitFor(() => handle.bus.subscriberCount(jobId) === 1);
  console.log(`  ✓ subscribed (server reports ${handle.bus.subscriberCount(jobId)} subscriber)\n`);

  // 4) Simulate agent activity by publishing onto the bus
  console.log('▶ Publishing synthetic agent activity (planner → implementer → reviewer)…\n');

  const publish = (agentId: string, event: Envelope['event']) => {
    handle.bus.publish(jobId, agentId, event);
  };

  publish('planner', {
    kind: 'request',
    ts: new Date().toISOString(),
    system: 'plan things',
    user: 'Add a small feature.',
    model: 'claude-opus-4-7',
    provider: 'anthropic',
  });
  await sleep(50);
  publish('planner', {
    kind: 'response',
    ts: new Date().toISOString(),
    text: '1. add component  2. wire it up  3. add a test',
  });
  await sleep(50);
  publish('implementer', {
    kind: 'request',
    ts: new Date().toISOString(),
    user: 'Carry out the plan.',
    model: 'claude-opus-4-7',
  });
  await sleep(50);
  publish('implementer', {
    kind: 'response',
    ts: new Date().toISOString(),
    text: 'wrote files: feature.ts, feature.test.ts',
  });
  await sleep(50);
  publish('reviewer', {
    kind: 'request',
    ts: new Date().toISOString(),
    user: 'Review the diff.',
    model: 'claude-opus-4-7',
  });
  await sleep(50);
  publish('reviewer', {
    kind: 'response',
    ts: new Date().toISOString(),
    text: 'LGTM with one nit: rename feature → addFeature.',
  });

  await waitFor(() => seen.length === 6, 1_000);

  console.log('\n▶ Closing SSE connection…');
  closeSse();
  await waitFor(() => handle.bus.subscriberCount(jobId) === 0);
  console.log(`  ✓ server reports ${handle.bus.subscriberCount(jobId)} subscribers after close\n`);

  console.log(
    `✓ Demo complete — ${seen.length} envelopes round-tripped through bus → SSE → client`,
  );
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
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function openSseStream(
  socketPath: string,
  path: string,
  onEnvelope: (env: Envelope) => void,
): () => void {
  let buffer = '';
  let closed = false;
  let received = false;

  const req = request({ socketPath, path, method: 'GET' }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      received = true;
      buffer += chunk;
      while (true) {
        const idx = buffer.indexOf('\n\n');
        if (idx < 0) break;
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              onEnvelope(JSON.parse(line.slice(6)) as Envelope);
            } catch {
              // skip malformed frame
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

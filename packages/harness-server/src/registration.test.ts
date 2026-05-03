import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startHarnessServer, type HarnessServerHandle } from './index.ts';
import type { PipelineCatalog } from './catalog.ts';

// macOS AF_UNIX sun_path is 104 chars — keep this short.
const tmpSocket = () => join(tmpdir(), `ax-${randomUUID().slice(0, 8)}.sock`);

interface UdsResponse {
  status: number;
  body: any;
}

function udsRequest(
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

const sampleCatalog: PipelineCatalog = {
  pipelines: [
    {
      id: 'feature-add',
      description: 'plan, build, review',
      agents: [
        { id: 'planner', role: 'Plan', adapter: 'claude-sdk', systemPrompt: 'plan it' },
        { id: 'implementer', role: 'Implement', adapter: 'claude-sdk' },
        { id: 'reviewer', role: 'Review', adapter: 'claude-sdk' },
      ],
    },
  ],
};

describe('agent registration on POST /v1/jobs', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  const start = async (catalog: PipelineCatalog = sampleCatalog) => {
    const socketPath = tmpSocket();
    const handle: HarnessServerHandle = await startHarnessServer({ socketPath, catalog });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });
    return { handle, socketPath };
  };

  it('registers coordinator + pipeline agents on submit', async () => {
    const { socketPath } = await start();
    const jobId = `job-${randomUUID().slice(0, 8)}`;

    const resp = await udsRequest(socketPath, 'POST', '/v1/jobs', {
      jobId,
      pipeline: 'feature-add',
      input: 'add a button',
    });

    expect(resp.status).toBe(200);
    expect(resp.body.ok).toBe(true);
    const agents = resp.body.job.agents;
    expect(agents.map((a: any) => a.id)).toEqual([
      'coordinator',
      'planner',
      'implementer',
      'reviewer',
    ]);
    expect(agents.every((a: any) => a.status === 'pending')).toBe(true);
    expect(agents.find((a: any) => a.id === 'planner').systemPrompt).toBe('plan it');
  });

  it('returns 400 for an unknown pipeline id with helpful message', async () => {
    const { socketPath } = await start();
    const resp = await udsRequest(socketPath, 'POST', '/v1/jobs', {
      jobId: 'job-1',
      pipeline: 'does-not-exist',
    });

    expect(resp.status).toBe(400);
    expect(resp.body.ok).toBe(false);
    expect(resp.body.error).toContain('does-not-exist');
    expect(resp.body.error).toContain('feature-add'); // lists known
  });

  it('returns 400 when jobId is missing', async () => {
    const { socketPath } = await start();
    const resp = await udsRequest(socketPath, 'POST', '/v1/jobs', { pipeline: 'feature-add' });

    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain('jobId');
  });

  it('registers coordinator-only when no pipeline is provided', async () => {
    const { socketPath } = await start();
    const resp = await udsRequest(socketPath, 'POST', '/v1/jobs', { jobId: 'job-bare' });

    expect(resp.status).toBe(200);
    const agents = resp.body.job.agents;
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe('coordinator');
  });

  it('GET /v1/jobs/:id/agents returns the registered list', async () => {
    const { socketPath } = await start();
    const jobId = `job-${randomUUID().slice(0, 8)}`;
    await udsRequest(socketPath, 'POST', '/v1/jobs', { jobId, pipeline: 'feature-add' });

    const resp = await udsRequest(socketPath, 'GET', `/v1/jobs/${jobId}/agents`);

    expect(resp.status).toBe(200);
    expect(resp.body.agents.map((a: any) => a.id)).toEqual([
      'coordinator',
      'planner',
      'implementer',
      'reviewer',
    ]);
  });

  it('GET /v1/jobs/:id/agents returns 404 for unknown job', async () => {
    const { socketPath } = await start();
    const resp = await udsRequest(socketPath, 'GET', '/v1/jobs/nope/agents');

    expect(resp.status).toBe(404);
    expect(resp.body.ok).toBe(false);
  });
});

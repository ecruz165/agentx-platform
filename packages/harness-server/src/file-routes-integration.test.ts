/**
 * End-to-end integration test for the harness-server file-browse routes.
 *
 *   GET /v1/jobs/:id/files                                   list with overlay
 *   GET /v1/jobs/:id/files/:repo/<path>/content              raw bytes
 *   GET /v1/jobs/:id/files/:repo/<path>/diff                 diff vs HEAD
 *
 * Sets up a real git repo as a product, submits a job, modifies +
 * stages files, then exercises each route. Verifies path-traversal
 * guards reject `..` escapes.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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

class PassthroughAdapter implements AgentAdapter {
  readonly events = new AdapterEventBus();
  constructor(private readonly reply: string) {}
  async invoke(spec: InvocationSpec): Promise<string> {
    this.events.emit({
      kind: 'request',
      ts: new Date().toISOString(),
      system: spec.system,
      user: spec.user,
      model: 'test',
    });
    this.events.emit({ kind: 'response', ts: new Date().toISOString(), text: this.reply });
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

/** Identity env so commits work without two extra `git config` spawns. */
const GIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@e.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@e.com',
};

describe('file-browse routes', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  // Bumped timeout: the setup spawns several git subprocesses + waits
  // for the harness-server runJob to fire. Under parallel load,
  // 5s is too tight; 15s gives headroom.
  it('lists files with change overlay; serves content + diff for staged changes', {
    timeout: 15_000,
  }, async () => {
    // Set up a workspace with a `web` repo.
    const workspaceRoot = join(tmpdir(), `ws-${randomUUID().slice(0, 8)}`);
    const repoPath = join(workspaceRoot, 'web');
    await mkdir(repoPath, { recursive: true });
    await runIn(repoPath, 'git', ['init', '-q', '-b', 'main']);
    // No git-config spawns — identity flows via GIT_IDENTITY_ENV in runIn.
    await writeFile(join(repoPath, 'README.md'), '# initial\n');
    await writeFile(join(repoPath, 'src.ts'), 'export const x = 1;\n');
    await runIn(repoPath, 'git', ['add', '.']);
    await runIn(repoPath, 'git', ['commit', '-q', '-m', 'init']);

    // Modify src.ts and stage it; add NEW.md and stage it.
    await writeFile(join(repoPath, 'src.ts'), 'export const x = 2;\n// updated\n');
    await writeFile(join(repoPath, 'NEW.md'), '# new file\n');
    await runIn(repoPath, 'git', ['add', '-A']);

    const socketPath = tmpSocket();
    const handle = await startHarnessServer({
      socketPath,
      catalog,
      broker: dummyBroker,
      adapterFactory: () => new PassthroughAdapter('done'),
      workspaceRoot,
    });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    });

    // Submit a job for the 'web' repo (productRepos drives discovery scope).
    await udsJson(socketPath, 'POST', '/v1/jobs', {
      jobId: 'fj1',
      pipeline: 'flat',
      input: 'go',
      productRepos: ['web'],
    });

    // Wait for the job to finish — the agent ran (PassthroughAdapter) and
    // discovery should have populated changedFiles. We don't strictly need
    // to wait for completion to call /files (it queries git directly), but
    // it ensures runJob fired.
    await waitFor(async () => {
      const r = await udsJson(socketPath, 'GET', '/v1/jobs/fj1');
      return r.body.job?.status === 'completed';
    });

    // GET /files — should include README.md (unchanged), src.ts (modified),
    // NEW.md (added).
    const list = await udsJson(socketPath, 'GET', '/v1/jobs/fj1/files');
    expect(list.status).toBe(200);
    const repos = list.body.repos as Array<{
      name: string;
      files: Array<{ path: string; changeKind: string }>;
    }>;
    expect(repos).toHaveLength(1);
    expect(repos[0]?.name).toBe('web');
    const byPath = new Map(repos[0]?.files.map((f) => [f.path, f]) ?? []);
    expect(byPath.get('README.md')?.changeKind).toBe('unchanged');
    expect(byPath.get('src.ts')?.changeKind).toBe('modified');
    expect(byPath.get('NEW.md')?.changeKind).toBe('added');
    expect(list.body.changedFiles).toBe(2);

    // GET .../content for src.ts → working tree bytes.
    const content = await udsJson(socketPath, 'GET', '/v1/jobs/fj1/files/web/src.ts/content');
    expect(content.status).toBe(200);
    expect(content.bodyText).toBe('export const x = 2;\n// updated\n');

    // GET .../diff for src.ts → unified diff.
    const diff = await udsJson(socketPath, 'GET', '/v1/jobs/fj1/files/web/src.ts/diff');
    expect(diff.status).toBe(200);
    expect(diff.bodyText).toMatch(/^diff --git/m);
    expect(diff.bodyText).toContain('-export const x = 1;');
    expect(diff.bodyText).toContain('+export const x = 2;');

    // GET .../diff for README.md (unchanged) → 204.
    const noDiff = await udsJson(socketPath, 'GET', '/v1/jobs/fj1/files/web/README.md/diff');
    expect(noDiff.status).toBe(204);

    // Path-traversal: ../etc/passwd → 400.
    const traversal = await udsJson(
      socketPath,
      'GET',
      '/v1/jobs/fj1/files/web/..%2Fescape/content',
    );
    expect(traversal.status).toBe(400);
    expect(traversal.body.error).toMatch(/path traversal/);

    // Unknown repo → 403.
    const wrongRepo = await udsJson(socketPath, 'GET', '/v1/jobs/fj1/files/api/anything/content');
    expect(wrongRepo.status).toBe(403);
    expect(wrongRepo.body.error).toMatch(/not in job.productRepos/);

    // Missing file → 404.
    const missing = await udsJson(
      socketPath,
      'GET',
      '/v1/jobs/fj1/files/web/no-such-file.ts/content',
    );
    expect(missing.status).toBe(404);
  });
});

interface UdsResponse {
  status: number;
  body: any;
  bodyText: string;
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
          let parsed: unknown = null;
          try {
            parsed = buf.length > 0 ? JSON.parse(buf) : null;
          } catch {
            // Non-JSON response (e.g., raw file content or diff text).
            parsed = null;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, bodyText: buf });
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

function runIn(cwd: string, cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...GIT_IDENTITY_ENV },
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}

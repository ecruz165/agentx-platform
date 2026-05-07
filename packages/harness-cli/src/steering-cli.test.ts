/**
 * End-to-end test for the `harness steering` CLI subcommand.
 *
 * Spawns the harness CLI as a subprocess against a live harness-server
 * (started in-process) over a Unix-domain socket. Verifies:
 *   1. `harness steering check --job <id>` returns the current array.
 *   2. `harness steering push --text "..."` appends to the steering.
 *   3. Subsequent check reflects the push.
 *   4. Missing --job and missing $HARNESS_JOB_ID errors with non-zero exit.
 *
 * Same pattern as the other harness-server integration tests — UDS
 * round-trip, no docker, no real LLM.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterEventBus, type AgentAdapter, type InvocationSpec } from '@ecruz165/agent-adapter';
import type { CredentialBroker } from '@ecruz165/agent-auth';
import type { Edge, FlowCatalog, FlowDef, TaskStep } from '@ecruz165/harness-core';
import { startHarnessServer } from '@ecruz165/harness-server';
import { afterEach, describe, expect, it } from 'vitest';

const tmpSocket = () => join(tmpdir(), `ax-${randomUUID().slice(0, 8)}.sock`);

const dummyBroker: CredentialBroker = {
  async getCredential(provider) {
    return { provider, apiKey: 'test', source: 'env' };
  },
};

class BlockingAdapter implements AgentAdapter {
  readonly events = new AdapterEventBus();
  private resolve: (() => void) | null = null;
  private blocked: Promise<void>;
  constructor() {
    this.blocked = new Promise((r) => {
      this.resolve = r;
    });
  }
  release(): void {
    this.resolve?.();
  }
  async invoke(spec: InvocationSpec): Promise<string> {
    this.events.emit({
      kind: 'request',
      ts: new Date().toISOString(),
      system: spec.system,
      user: spec.user,
      model: 'test',
    });
    await this.blocked;
    this.events.emit({ kind: 'response', ts: new Date().toISOString(), text: 'done' });
    return 'done';
  }
}

function flatFlow(): FlowDef {
  const nodes: TaskStep[] = [
    { id: '__trigger', kind: 'trigger', config: { kind: 'manual' } },
    {
      id: 'a',
      kind: 'agent',
      config: { agent: { id: 'a', role: 'A', adapter: 'claude-sdk', systemPrompt: 'do' } },
    },
  ];
  const edges: Edge[] = [{ from: '__trigger', to: 'a', type: 'sequence' }];
  return { id: 'flat', nodes, edges };
}

const catalog: FlowCatalog = { flows: [flatFlow()] };

const CLI_BIN = new URL('./index.ts', import.meta.url).pathname;

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath.endsWith('bun') ? 'bun' : 'bun', [CLI_BIN, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

describe('harness steering CLI', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('check returns current steering for a job; push appends', async () => {
    const socketPath = tmpSocket();
    // Workspace root needs a .harness/run/ for the CLI to find the
    // socket via its findWorkspaceRoot walk-up. Use a tmpdir-rooted
    // path so the CLI's `<workspace>/.harness/run/harness.sock` matches
    // what we tell startHarnessServer.
    const adapters: BlockingAdapter[] = [];
    const handle = await startHarnessServer({
      socketPath,
      catalog,
      broker: dummyBroker,
      adapterFactory: () => {
        const a = new BlockingAdapter();
        adapters.push(a);
        return a;
      },
    });
    cleanups.push(async () => {
      for (const a of adapters) a.release();
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    // Submit a job via direct HTTP-over-UDS so we don't depend on the
    // CLI submit path here (we're testing the steering subcommand).
    const { request } = await import('node:http');
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          socketPath,
          path: '/v1/jobs',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve());
        },
      );
      req.on('error', reject);
      req.write(JSON.stringify({ jobId: 'cli-1', pipeline: 'flat', input: 'go' }));
      req.end();
    });

    // Wait briefly for the runJob graph to compile + register in the
    // dispatcher's graphs cache (otherwise steerJob errors with "no
    // cached graph"). 200ms is generous.
    await new Promise((r) => setTimeout(r, 250));

    // The CLI uses HARNESS_WORKSPACE env to short-circuit findWorkspaceRoot.
    // That root must contain `.harness/run/harness.sock` pointing at our
    // socketPath. Easiest: symlink tmp socket dir into a workspace dir.
    // For this test, override HARNESS_WORKSPACE to the socketPath's
    // grandparent (so .harness/run/<basename> matches).
    // socketPath: /tmp/ax-XXXX.sock — parent is /tmp. We need
    // <root>/.harness/run/<basename>. Restructure: create a workspace
    // dir, mkdir .harness/run, symlink the socket.
    const { mkdir, symlink } = await import('node:fs/promises');
    const workspaceRoot = join(tmpdir(), `ws-${randomUUID().slice(0, 8)}`);
    await mkdir(join(workspaceRoot, '.harness', 'run'), { recursive: true });
    const linkedSocket = join(workspaceRoot, '.harness', 'run', 'harness.sock');
    await symlink(socketPath, linkedSocket);
    cleanups.push(async () => {
      await rm(workspaceRoot, { recursive: true, force: true });
    });

    // 1. check → empty
    const check1 = await runCli(['steering', 'check', '--job', 'cli-1'], {
      HARNESS_WORKSPACE: workspaceRoot,
    });
    expect(check1.exitCode).toBe(0);
    const body1 = JSON.parse(check1.stdout);
    expect(body1.steering).toEqual([]);

    // 2. push
    const push1 = await runCli(['steering', 'push', '--job', 'cli-1', '--text', 'use OAuth'], {
      HARNESS_WORKSPACE: workspaceRoot,
    });
    expect(push1.exitCode).toBe(0);

    // 3. check → reflects push
    const check2 = await runCli(['steering', 'check', '--job', 'cli-1'], {
      HARNESS_WORKSPACE: workspaceRoot,
    });
    expect(check2.exitCode).toBe(0);
    const body2 = JSON.parse(check2.stdout);
    expect(body2.steering).toEqual(['use OAuth']);
  });

  it('errors when no jobId is provided', async () => {
    const r = await runCli(['steering', 'check'], { HARNESS_JOB_ID: '' });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/No jobId provided/);
  });
});

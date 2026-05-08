/**
 * In-process integration tests — spin up edge-memory-server with the
 * default InMemoryMemoryStore, then call `run()` against the resulting
 * socket. Asserts happy paths + error shaping.
 *
 * Each test uses an isolated tmp socket; teardown closes the server
 * and removes the socket file.
 */

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMemoryServer } from '@ecruz165/edge-memory-server';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from './main.ts';

const tmpSocket = () => join(tmpdir(), `memcli-${randomUUID().slice(0, 8)}.sock`);

interface CapturedIO {
  stdout: string;
  stderr: string;
}

async function runCli(argv: string[], socketPath: string): Promise<{ code: number } & CapturedIO> {
  let stdout = '';
  let stderr = '';
  const code = await run({
    argv,
    env: { MEMORY_SOCKET_PATH: socketPath, HOME: process.env.HOME ?? '/tmp' },
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
  });
  return { code, stdout, stderr };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function startServer(): Promise<string> {
  const socketPath = tmpSocket();
  const handle = await startMemoryServer({ socketPath });
  cleanups.push(async () => {
    await handle.stop();
    await rm(socketPath, { force: true });
  });
  return socketPath;
}

describe('edge-memory CLI — happy paths', () => {
  it('put → query (structured) round-trip', async () => {
    const socket = await startServer();

    const put = await runCli(['put', 'plan', '--value', 'use OAuth'], socket);
    expect(put.code).toBe(0);
    expect(put.stdout).toMatch(/stored mem_/);

    const query = await runCli(['query', '--type', 'structured', '--key', 'plan'], socket);
    expect(query.code).toBe(0);
    expect(query.stdout).toContain('use OAuth');
    expect(query.stdout).toContain('[plan]');
  });

  it('put with --scope tags applies AND-filter on query', async () => {
    const socket = await startServer();

    await runCli(['put', 'k', '--value', 'A', '--scope', 'productId:web'], socket);
    await runCli(['put', 'k', '--value', 'B', '--scope', 'productId:api'], socket);

    const onlyWeb = await runCli(
      ['query', '--type', 'structured', '--key', 'k', '--scope', 'productId:web'],
      socket,
    );
    expect(onlyWeb.code).toBe(0);
    expect(onlyWeb.stdout).toContain('A');
    expect(onlyWeb.stdout).not.toContain('B');
  });

  it('query --type recent returns newest first with --limit', async () => {
    const socket = await startServer();
    for (const v of ['first', 'second', 'third']) {
      await runCli(['put', 'log', '--value', v], socket);
      await new Promise((r) => setTimeout(r, 5));
    }
    const recent = await runCli(['query', '--type', 'recent', '--limit', '2'], socket);
    expect(recent.code).toBe(0);
    // Newest first, limit 2.
    expect(recent.stdout).toContain('third');
    expect(recent.stdout).toContain('second');
    expect(recent.stdout).not.toContain('first');
  });

  it('forget --key deletes matching entries; reports count', async () => {
    const socket = await startServer();
    await runCli(['put', 'plan', '--value', 'A'], socket);
    await runCli(['put', 'plan', '--value', 'B'], socket);
    await runCli(['put', 'other', '--value', 'C'], socket);

    const forget = await runCli(['forget', '--key', 'plan'], socket);
    expect(forget.code).toBe(0);
    expect(forget.stdout).toContain('deleted 2');

    const remaining = await runCli(['query', '--type', 'structured'], socket);
    expect(remaining.stdout).toContain('C');
    expect(remaining.stdout).not.toContain('A');
  });

  it('health emits backend state', async () => {
    const socket = await startServer();
    const r = await runCli(['health'], socket);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/state: warm/);
    expect(r.stdout).toMatch(/backend: InMemoryMemoryStore/);
  });

  it('--json emits JSON for machine consumption', async () => {
    const socket = await startServer();
    const r = await runCli(['health', '--json'], socket);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.service).toBe('memory');
    expect(parsed.state).toBe('warm');
  });

  it('similarity query against in-memory backend returns unsupported', async () => {
    const socket = await startServer();
    await runCli(['put', 'k', '--value', 'something'], socket);
    // InMemoryMemoryStore returns kind:'unsupported' for similarity —
    // CLI surfaces the reason in human format.
    const r = await runCli(['query', '--type', 'similarity', '--q', 'anything'], socket);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/unsupported.*sqlite-vec/);
  });
});

describe('edge-memory CLI — error paths', () => {
  it('exits 2 with usage when no command given', async () => {
    const socket = await startServer();
    const r = await runCli([], socket);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('Usage:');
  });

  it('exits 2 on unknown command', async () => {
    const socket = await startServer();
    const r = await runCli(['nonexistent'], socket);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown command/);
  });

  it('exits 1 with helpful message when socket missing (ENOENT)', async () => {
    const r = await runCli(['health'], '/tmp/nonexistent-socket.sock');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/socket not found/);
    expect(r.stderr).toMatch(/edge-memory-server/);
  });

  it('exits 1 on server-side validation error (forget with empty predicate)', async () => {
    const socket = await startServer();
    const r = await runCli(['forget'], socket);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/at least one of/);
  });

  it('put without --value fails with helpful error', async () => {
    const socket = await startServer();
    const r = await runCli(['put', 'plan'], socket);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--value/);
  });
});

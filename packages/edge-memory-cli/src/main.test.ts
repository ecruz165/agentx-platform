/**
 * In-process integration tests — spin up edge-memory-server with the
 * default InMemoryMemoryStore, then call `run()` against the resulting
 * socket. Asserts happy paths + error shaping.
 *
 * Each test uses an isolated tmp socket; teardown closes the server
 * and removes the socket file.
 */

import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
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

  it('export emits JSONL on stdout (one line per entry)', async () => {
    const socket = await startServer();
    await runCli(['put', 'a', '--value', 'A', '--scope', 'productId:web'], socket);
    await runCli(['put', 'b', '--value', 'B', '--scope', 'productId:api'], socket);

    const r = await runCli(['export'], socket);
    expect(r.code).toBe(0);
    const lines = r.stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.map((e) => e.value).sort()).toEqual(['A', 'B']);
  });

  it('export with --scope filters entries', async () => {
    const socket = await startServer();
    await runCli(['put', 'a', '--value', 'A', '--scope', 'productId:web'], socket);
    await runCli(['put', 'b', '--value', 'B', '--scope', 'productId:api'], socket);

    const r = await runCli(['export', '--scope', 'productId:web'], socket);
    expect(r.code).toBe(0);
    const lines = r.stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).value).toBe('A');
  });

  it('export --out writes to file instead of stdout', async () => {
    const socket = await startServer();
    await runCli(['put', 'plan', '--value', 'persisted'], socket);
    const outPath = join(tmpdir(), `mem-export-${randomUUID().slice(0, 8)}.jsonl`);
    cleanups.push(async () => {
      await rm(outPath, { force: true });
    });

    const r = await runCli(['export', '--out', outPath], socket);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(''); // nothing on stdout when --out is set
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(outPath, 'utf8');
    expect(content).toContain('persisted');
  });

  it('import --in reads JSONL from file and puts each line', async () => {
    const socket = await startServer();
    const inPath = join(tmpdir(), `mem-import-${randomUUID().slice(0, 8)}.jsonl`);
    const jsonl = [
      JSON.stringify({ key: 'a', value: 'A' }),
      JSON.stringify({ key: 'b', value: 'B', scope: { productId: 'web' } }),
    ].join('\n');
    await writeFile(inPath, jsonl, 'utf8');
    cleanups.push(async () => {
      await rm(inPath, { force: true });
    });

    const r = await runCli(['import', '--in', inPath], socket);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/imported 2 entries/);

    const queried = await runCli(['query', '--type', 'structured', '--json'], socket);
    const result = JSON.parse(queried.stdout);
    expect(result.entries).toHaveLength(2);
  });

  it('import reports per-line errors and exits 1 when any line fails', async () => {
    const socket = await startServer();
    const inPath = join(tmpdir(), `mem-import-${randomUUID().slice(0, 8)}.jsonl`);
    const jsonl = [
      JSON.stringify({ key: 'a', value: 'A' }),
      'not-json{',
      JSON.stringify({ value: 'orphan' }), // missing key
    ].join('\n');
    await writeFile(inPath, jsonl, 'utf8');
    cleanups.push(async () => {
      await rm(inPath, { force: true });
    });

    const r = await runCli(['import', '--in', inPath], socket);
    expect(r.code).toBe(1); // any error → exit 1
    expect(r.stdout).toMatch(/imported 1 entries/);
    expect(r.stderr).toMatch(/line 2/);
    expect(r.stderr).toMatch(/line 3/);
  });

  it('audit lists events newest-first (human format)', async () => {
    const socket = await startServer();
    await runCli(['put', 'a', '--value', 'A', '--scope', 'productId:web'], socket);
    await runCli(['put', 'b', '--value', 'B'], socket);
    await runCli(['forget', '--key', 'a'], socket);

    const r = await runCli(['audit'], socket);
    expect(r.code).toBe(0);
    const lines = r.stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    // Newest first: forget then 2 puts.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/forget/);
    expect(lines[0]).toMatch(/count=1/);
    // PRD F33: actor is uds:<uid> on POSIX, uds:local on Windows.
    expect(lines[0]).toMatch(/actor=uds:(\d+|local)/);
  });

  it('audit --op filters', async () => {
    const socket = await startServer();
    await runCli(['put', 'a', '--value', 'A'], socket);
    await runCli(['put', 'b', '--value', 'B'], socket);
    await runCli(['forget', '--key', 'a'], socket);

    const onlyForget = await runCli(['audit', '--op', 'forget'], socket);
    expect(onlyForget.code).toBe(0);
    const lines = onlyForget.stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/forget/);
  });

  it('audit --scope filters by scope subset', async () => {
    const socket = await startServer();
    await runCli(['put', 'a', '--value', 'A', '--scope', 'productId:web'], socket);
    await runCli(['put', 'b', '--value', 'B', '--scope', 'productId:api'], socket);

    const webOnly = await runCli(['audit', '--scope', 'productId:web'], socket);
    expect(webOnly.code).toBe(0);
    const lines = webOnly.stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/productId=web/);
  });

  it('audit --json emits the full event objects', async () => {
    const socket = await startServer();
    await runCli(['put', 'a', '--value', 'A'], socket);
    const r = await runCli(['audit', '--json'], socket);
    expect(r.code).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].op).toBe('put');
    expect(result.events[0].entryIds).toHaveLength(1);
  });

  it('audit on a fresh server returns no events', async () => {
    const socket = await startServer();
    const r = await runCli(['audit'], socket);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no events/);
  });

  it('export → import roundtrip preserves content (ids reissued)', async () => {
    const socket = await startServer();
    await runCli(['put', 'plan', '--value', 'A'], socket);
    await runCli(['put', 'plan', '--value', 'B'], socket);

    const exported = await runCli(['export'], socket);
    expect(exported.code).toBe(0);

    // Forget then re-import.
    await runCli(['forget', '--key', 'plan'], socket);
    const inPath = join(tmpdir(), `mem-roundtrip-${randomUUID().slice(0, 8)}.jsonl`);
    await writeFile(inPath, exported.stdout, 'utf8');
    cleanups.push(async () => {
      await rm(inPath, { force: true });
    });

    const imp = await runCli(['import', '--in', inPath], socket);
    expect(imp.code).toBe(0);

    const queried = await runCli(['query', '--type', 'structured', '--json'], socket);
    const result = JSON.parse(queried.stdout);
    expect(result.entries).toHaveLength(2);
    const values = result.entries.map((e: { value: string }) => e.value);
    expect(values.sort()).toEqual(['A', 'B']);
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

  it('rejects --socket and --workspace together (mutually exclusive)', async () => {
    let stderr = '';
    const code = await run({
      argv: ['health', '--socket', '/tmp/x.sock', '--workspace', 'foo'],
      env: {},
      stdout: () => {},
      stderr: (s) => {
        stderr += s;
      },
    });
    expect(code).toBe(2);
    expect(stderr).toMatch(/mutually exclusive/);
  });
});

describe('edge-memory CLI — tag (F18)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function startServer(): Promise<string> {
    const socketPath = join(tmpdir(), `tag-cli-${randomUUID().slice(0, 8)}.sock`);
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });
    return socketPath;
  }

  it('tag --scope --feedback positive — human format reports tagged count', async () => {
    const socket = await startServer();
    await runCli(['put', 'plan', '--value', 'A', '--scope', 'jobId:j1'], socket);
    await runCli(['put', 'plan', '--value', 'B', '--scope', 'jobId:j1'], socket);

    const tag = await runCli(
      ['tag', '--scope', 'jobId:j1', '--feedback', 'positive', '--source', 'phase-success'],
      socket,
    );
    expect(tag.code).toBe(0);
    expect(tag.stdout).toMatch(/tagged 2/);
    expect(tag.stdout).toMatch(/feedback=positive/);
  });

  it('tag --entry <id> --feedback negative', async () => {
    const socket = await startServer();
    const put = await runCli(['put', 'k', '--value', 'A', '--json'], socket);
    const id = JSON.parse(put.stdout).entry.id as string;

    const tag = await runCli(
      ['tag', '--entry', id, '--feedback', 'negative', '--source', 'pr-rejected'],
      socket,
    );
    expect(tag.code).toBe(0);
    expect(tag.stdout).toMatch(/tagged 1/);
  });

  it('rejects missing --feedback with usage error (exit 2)', async () => {
    const socket = await startServer();
    const r = await runCli(['tag', '--key', 'plan'], socket);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--feedback/);
  });

  it('--json emits machine-readable result', async () => {
    const socket = await startServer();
    await runCli(['put', 'plan', '--value', 'A'], socket);
    const tag = await runCli(['tag', '--key', 'plan', '--feedback', 'positive', '--json'], socket);
    const body = JSON.parse(tag.stdout);
    expect(body.tagged).toBe(1);
    expect(body.alreadyTagged).toBe(0);
    expect(body.taggedIds).toHaveLength(1);
  });

  it('--overwrite re-tags already-tagged entries', async () => {
    const socket = await startServer();
    await runCli(['put', 'plan', '--value', 'A'], socket);
    await runCli(['tag', '--key', 'plan', '--feedback', 'positive'], socket);

    const skip = await runCli(['tag', '--key', 'plan', '--feedback', 'negative', '--json'], socket);
    expect(JSON.parse(skip.stdout).tagged).toBe(0);
    expect(JSON.parse(skip.stdout).alreadyTagged).toBe(1);

    const force = await runCli(
      ['tag', '--key', 'plan', '--feedback', 'negative', '--overwrite', '--json'],
      socket,
    );
    expect(JSON.parse(force.stdout).tagged).toBe(1);
  });
});

describe('edge-memory CLI — inspect (F37)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });
  async function startServer(): Promise<string> {
    const socketPath = join(tmpdir(), `inspect-cli-${randomUUID().slice(0, 8)}.sock`);
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });
    return socketPath;
  }

  it('inspect prints total + feedback + scope breakdown', async () => {
    const socket = await startServer();
    await runCli(['put', 'a', '--value', 'A', '--scope', 'jobId:j1'], socket);
    await runCli(['put', 'b', '--value', 'B', '--scope', 'jobId:j1'], socket);
    await runCli(['tag', '--key', 'a', '--feedback', 'positive'], socket);

    const r = await runCli(['inspect'], socket);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/total: 2/);
    expect(r.stdout).toMatch(/feedback: \+1 −0 \?1/);
    expect(r.stdout).toMatch(/jobIds: j1=2/);
  });

  it('--json emits raw aggregate', async () => {
    const socket = await startServer();
    await runCli(['put', 'a', '--value', 'A'], socket);
    const r = await runCli(['inspect', '--json'], socket);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.totalEntries).toBe(1);
  });

  it('--show-lineage surfaces per-entry breakdown in human format', async () => {
    const socket = await startServer();
    await runCli(['put', 'plan', '--value', 'A', '--scope', 'jobId:j1'], socket);
    await runCli(['tag', '--key', 'plan', '--feedback', 'positive'], socket);
    await runCli(['consolidate', '--from', 'jobId:j1', '--to', 'productId:web'], socket);

    const r = await runCli(['inspect', '--scope', 'productId:web', '--show-lineage'], socket);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('lineage:');
    expect(r.stdout).toMatch(/feedback=positive/);
    expect(r.stdout).toMatch(/via=rule/);
  });
});

describe('edge-memory CLI — snapshot + restore (F5)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });
  async function startServer(): Promise<string> {
    const socketPath = join(tmpdir(), `snap-cli-${randomUUID().slice(0, 8)}.sock`);
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });
    return socketPath;
  }

  it('snapshot --scope → restore --snapshot round-trips', async () => {
    const socket = await startServer();
    await runCli(['put', 'k', '--value', 'A', '--scope', 'sessionId:s1'], socket);

    const snap = await runCli(['snapshot', '--scope', 'sessionId:s1', '--json'], socket);
    expect(snap.code).toBe(0);
    const snapshotId = JSON.parse(snap.stdout).snapshotId as string;
    expect(snapshotId).toMatch(/^snap_/);

    await runCli(['forget', '--scope', 'sessionId:s1'], socket);

    const restore = await runCli(['restore', '--snapshot', snapshotId], socket);
    expect(restore.code).toBe(0);
    expect(restore.stdout).toMatch(/restored 1/);

    const after = await runCli(
      ['query', '--type', 'structured', '--scope', 'sessionId:s1', '--json'],
      socket,
    );
    expect(JSON.parse(after.stdout).entries).toHaveLength(1);
  });

  it('snapshot rejects missing --scope (exit 2)', async () => {
    const socket = await startServer();
    const r = await runCli(['snapshot'], socket);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--scope/);
  });

  it('restore rejects missing --snapshot (exit 2)', async () => {
    const socket = await startServer();
    const r = await runCli(['restore'], socket);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--snapshot/);
  });
});

describe('edge-memory CLI — cleanup (F19)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });
  async function startServer(): Promise<string> {
    const socketPath = join(tmpdir(), `cleanup-${randomUUID().slice(0, 8)}.sock`);
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });
    return socketPath;
  }

  it('cleanup --scope jobId:X — reports unconfirmed count', async () => {
    const socket = await startServer();
    await runCli(['put', 'a', '--value', 'A', '--scope', 'jobId:j1'], socket);
    await runCli(['put', 'b', '--value', 'B', '--scope', 'jobId:j1'], socket);
    await runCli(['put', 'c', '--value', 'C', '--scope', 'jobId:j1'], socket);
    await runCli(['tag', '--key', 'a', '--feedback', 'positive'], socket);

    const r = await runCli(['cleanup', '--scope', 'jobId:j1'], socket);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/cleaned up 2 unconfirmed/);
  });

  it('rejects missing --scope (refuses global wipe at the CLI layer)', async () => {
    const socket = await startServer();
    const r = await runCli(['cleanup'], socket);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--scope/);
  });
});

describe('edge-memory CLI — consolidate (F14/F15)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });
  async function startServer(): Promise<string> {
    const socketPath = join(tmpdir(), `consol-${randomUUID().slice(0, 8)}.sock`);
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });
    return socketPath;
  }

  it('consolidate --from --to promotes positive+negative; reports breakdown', async () => {
    const socket = await startServer();
    await runCli(['put', 'plan', '--value', 'A', '--scope', 'jobId:j1'], socket);
    await runCli(['put', 'plan', '--value', 'B', '--scope', 'jobId:j1'], socket);
    await runCli(['tag', '--scope', 'jobId:j1', '--feedback', 'positive'], socket);

    const r = await runCli(['consolidate', '--from', 'jobId:j1', '--to', 'productId:web'], socket);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/promoted 2/);
    expect(r.stdout).toMatch(/\+2 −0/);
  });

  it('rejects missing --from / --to with usage error', async () => {
    const socket = await startServer();
    const r = await runCli(['consolidate'], socket);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--from/);
  });

  it('--feedback-filter accepts comma-separated', async () => {
    const socket = await startServer();
    await runCli(['put', 'a', '--value', 'A', '--scope', 'jobId:j1'], socket);
    await runCli(['put', 'b', '--value', 'B', '--scope', 'jobId:j1'], socket);
    await runCli(['tag', '--key', 'a', '--feedback', 'positive'], socket);
    await runCli(['tag', '--key', 'b', '--feedback', 'negative'], socket);

    const onlyPos = await runCli(
      [
        'consolidate',
        '--from',
        'jobId:j1',
        '--to',
        'productId:web',
        '--feedback-filter',
        'positive',
        '--keep-source',
        '--json',
      ],
      socket,
    );
    expect(onlyPos.code).toBe(0);
    const result = JSON.parse(onlyPos.stdout);
    expect(result.promoted).toBe(1);
    expect(result.feedbackBreakdown).toEqual({ positive: 1, negative: 0 });
  });
});

describe('edge-memory CLI — precedence chains (F3a/F3b)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function startServer(): Promise<string> {
    const socketPath = join(tmpdir(), `prec-${randomUUID().slice(0, 8)}.sock`);
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });
    return socketPath;
  }

  async function runCliWithEnv(
    argv: string[],
    socket: string,
    extraEnv: Record<string, string>,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    const code = await run({
      argv,
      env: { MEMORY_SOCKET_PATH: socket, HOME: '/tmp', ...extraEnv },
      stdout: (s) => {
        stdout += s;
      },
      stderr: (s) => {
        stderr += s;
      },
    });
    return { code, stdout, stderr };
  }

  it('F3b: put without --scope writes to JOB_ID env when set', async () => {
    const socket = await startServer();
    await runCliWithEnv(['put', 'k', '--value', 'A'], socket, { JOB_ID: 'j_42' });

    // Query by jobId scope to verify the entry landed there.
    const q = await runCliWithEnv(
      ['query', '--type', 'structured', '--key', 'k', '--scope', 'jobId:j_42', '--json'],
      socket,
      {},
    );
    expect(JSON.parse(q.stdout).entries).toHaveLength(1);
  });

  it('F3b: put falls through to SESSION_ID when JOB_ID is unset', async () => {
    const socket = await startServer();
    await runCliWithEnv(['put', 'k', '--value', 'A'], socket, { SESSION_ID: 's_1' });

    const q = await runCliWithEnv(
      ['query', '--type', 'structured', '--scope', 'sessionId:s_1', '--json'],
      socket,
      {},
    );
    expect(JSON.parse(q.stdout).entries).toHaveLength(1);
  });

  it('F3b: explicit --scope wins over env', async () => {
    const socket = await startServer();
    await runCliWithEnv(['put', 'k', '--value', 'A', '--scope', 'productId:web'], socket, {
      JOB_ID: 'j_42',
    });

    // Should be queryable by productId, not by jobId.
    const byProd = await runCliWithEnv(
      ['query', '--type', 'structured', '--scope', 'productId:web', '--json'],
      socket,
      {},
    );
    expect(JSON.parse(byProd.stdout).entries).toHaveLength(1);
    const byJob = await runCliWithEnv(
      ['query', '--type', 'structured', '--scope', 'jobId:j_42', '--json'],
      socket,
      {},
    );
    expect(JSON.parse(byJob.stdout).entries).toHaveLength(0);
  });

  it('F3a: query without --scope walks chain narrow→wide; first hit wins', async () => {
    const socket = await startServer();
    // Plant entry only at productId scope, env says try job first.
    await runCliWithEnv(
      ['put', 'shared-note', '--value', 'product-level', '--scope', 'productId:web'],
      socket,
      {},
    );

    // No --scope; env supplies JOB_ID + PRODUCT_ID. job has nothing,
    // product has the entry → first-hit returns product-level.
    const q = await runCliWithEnv(
      ['query', '--type', 'structured', '--key', 'shared-note', '--json'],
      socket,
      { JOB_ID: 'j_no_match', PRODUCT_ID: 'web' },
    );
    const parsed = JSON.parse(q.stdout);
    expect(parsed.kind).toBe('ok');
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].value).toBe('product-level');
  });

  it('F3a: --mode=union returns hits across all chain scopes', async () => {
    const socket = await startServer();
    await runCliWithEnv(['put', 'k', '--value', 'job', '--scope', 'jobId:j1'], socket, {});
    await runCliWithEnv(['put', 'k', '--value', 'product', '--scope', 'productId:web'], socket, {});

    const q = await runCliWithEnv(
      ['query', '--type', 'structured', '--key', 'k', '--mode', 'union', '--json'],
      socket,
      { JOB_ID: 'j1', PRODUCT_ID: 'web' },
    );
    const parsed = JSON.parse(q.stdout);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries.map((e: { value: string }) => e.value).sort()).toEqual([
      'job',
      'product',
    ]);
  });

  it('F3a: query without --scope and without env falls back to no-scope (global)', async () => {
    const socket = await startServer();
    await runCliWithEnv(['put', 'k', '--value', 'global'], socket, {});

    const q = await runCliWithEnv(
      ['query', '--type', 'structured', '--key', 'k', '--json'],
      socket,
      {},
    );
    expect(JSON.parse(q.stdout).entries).toHaveLength(1);
  });
});

describe('edge-memory CLI — workspace flag (F27)', () => {
  it('--workspace <name> resolves to ~/.harness/workspaces/<name>/run/memory.sock', async () => {
    // We just check the error path — the path doesn't exist, so we
    // get an ENOENT with the expanded path in the error.
    let stderr = '';
    const code = await run({
      argv: ['health', '--workspace', 'mobile-app'],
      env: { HOME: '/tmp/home-fixture' },
      stdout: () => {},
      stderr: (s) => {
        stderr += s;
      },
    });
    expect(code).toBe(1);
    expect(stderr).toContain('/tmp/home-fixture/.harness/workspaces/mobile-app/run/memory.sock');
  });
});

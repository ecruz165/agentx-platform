/**
 * bin.ts integration tests — spawn the binary as a real subprocess
 * (via tsx, which is the workspace's TypeScript loader) and assert on
 * the JSONL stdout shape + exit code.
 *
 * Why subprocess and not in-process: bin.ts is a CLI entrypoint with
 * a top-level main() that calls process.exit(). Running it in-process
 * would terminate the test runner. Subprocess isolation gives us the
 * real exit-code surface we need to validate.
 *
 * Test scope: spec → JobSpec parse → runHarnessPipeline → JSONL on
 * stdout → exit code. We use a coordinator-only spec (zero LLM calls)
 * so the test doesn't need credentials / mocks. The full event-flow
 * test for non-trivial pipelines lives in run-pipeline-subprocess
 * tests on the parent (harness-server) side, where adapters can be
 * injected via the spec's bindings.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const BIN = resolve(__dirname, 'bin.ts');
const TSX = resolve(__dirname, '../../../node_modules/.bin/tsx');

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(TSX, [BIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', rejectP);
    child.on('close', (code) => resolveP({ stdout, stderr, code: code ?? 0 }));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

function parseJsonl(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

const tmps: string[] = [];
async function tmpSpecFile(spec: object): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-pipeline-bin-'));
  tmps.push(dir);
  const path = join(dir, 'spec.json');
  await writeFile(path, JSON.stringify(spec));
  return path;
}

describe('bin.ts (slice 9d-1 subprocess executor)', () => {
  beforeAll(() => {
    // Confirm the runtime resolved — gives a clearer failure than
    // "spawn ENOENT" if tsx isn't where we expect.
    if (!TSX.endsWith('/tsx')) {
      throw new Error(`tsx path looks wrong: ${TSX}`);
    }
  });

  afterEach(async () => {
    for (const dir of tmps.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 when no spec path is provided', async () => {
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('usage:');
  });

  it('exits 2 when spec path does not exist', async () => {
    const result = await run(['/nonexistent/spec.json']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('failed to read spec');
  });

  it('exits 2 when spec is malformed JSON', async () => {
    const result = await run(['-'], 'not json {');
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/spec parse failed|spec error/);
  });

  it('exits 2 when spec has unsupported version', async () => {
    const result = await run(['-'], JSON.stringify({ version: 99, jobId: 'j' }));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unsupported version');
  });

  it('runs a coordinator-only spec to completion (zero envelopes, sentinel only)', async () => {
    // The coordinator agent is skipped by runJob (it's a synthetic
    // placeholder), so this spec produces no adapter events. Only the
    // job-complete sentinel is emitted on stdout.
    const spec = {
      version: 1,
      jobId: 'j-coord-only',
      set: 'default',
      agents: [
        { id: 'coordinator', role: 'Coordinator', adapter: 'claude-sdk' },
      ],
      bindings: {},
    };
    const path = await tmpSpecFile(spec);
    const result = await run([path]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const lines = parseJsonl(result.stdout);
    // Only the sentinel — no agent events because coordinator is skipped.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      kind: 'job-complete',
      jobId: 'j-coord-only',
      status: 'completed',
    });
  });

  it('reads spec from stdin when path is "-"', async () => {
    const spec = {
      version: 1,
      jobId: 'j-stdin',
      set: 'default',
      agents: [
        { id: 'coordinator', role: 'Coordinator', adapter: 'claude-sdk' },
      ],
      bindings: {},
    };
    const result = await run(['-'], JSON.stringify(spec));
    expect(result.code).toBe(0);
    const lines = parseJsonl(result.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'job-complete', jobId: 'j-stdin' });
  });

  it('emits sentinel even for an empty agents list (degenerate but valid spec)', async () => {
    const spec = {
      version: 1,
      jobId: 'j-empty',
      set: 'default',
      agents: [],
      bindings: {},
    };
    const path = await tmpSpecFile(spec);
    const result = await run([path]);
    expect(result.code).toBe(0);
    const lines = parseJsonl(result.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      kind: 'job-complete',
      jobId: 'j-empty',
      status: 'completed',
    });
  });
});

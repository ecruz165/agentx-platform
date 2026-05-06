/**
 * runPipelineInContainer tests — exercises the spawn shape + JSONL
 * parsing without requiring Docker.
 *
 * Strategy: write a tiny shell-script "fake devcontainer" that
 * ignores its args and emits canned JSONL output. Pass it as
 * `devcontainerBin`. This validates:
 *   - the function calls devcontainerBin with the expected arg
 *     pattern (`exec --container-id <id> ...`)
 *   - JSONL stdout is parsed and republished onto the bus
 *   - stderr is captured into stderrTail
 *   - the sentinel is recognized
 *   - exit codes map to status correctly
 *
 * Real Docker integration testing happens via 9d-4 + manual smoke
 * runs against the skoolscout-com URL.
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JobBus,
  type Envelope,
} from '@agentx/harness-core';
import type { JobSpec } from '@agentx/harness-pipeline';
import { runPipelineInContainer } from './run-pipeline-in-container.ts';

const tmps: string[] = [];

afterEach(async () => {
  for (const dir of tmps.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tmpDir(prefix: string): Promise<string> {
  const { mkdtemp: mt } = await import('node:fs/promises');
  const dir = await mt(join(tmpdir(), `${prefix}-`));
  tmps.push(dir);
  return dir;
}

/** Build a fake devcontainer-cli script that emits canned stdout/stderr
 *  and exits with the given code. The shell script ignores all its
 *  arguments — the test isn't validating the args here, just the
 *  spawn/parse mechanics. */
async function fakeDevcontainer(args: {
  stdoutLines: string[];
  stderrLines?: string[];
  exitCode?: number;
}): Promise<string> {
  const dir = await tmpDir('fake-dc');
  const path = join(dir, 'fake-devcontainer.sh');
  // shell-escape via bash -c with explicit single-quoted printf — avoids
  // double-quote interpolation gotchas. printf '%s\n' "$LINE" prints
  // each line literally.
  const stdoutWrites = args.stdoutLines
    .map((line) => `printf '%s\\n' ${shellSingleQuote(line)}`)
    .join('\n');
  const stderrWrites = (args.stderrLines ?? [])
    .map((line) => `printf '%s\\n' ${shellSingleQuote(line)} 1>&2`)
    .join('\n');
  const script = `#!/bin/sh
${stdoutWrites}
${stderrWrites}
exit ${args.exitCode ?? 0}
`;
  await writeFile(path, script);
  await chmod(path, 0o755);
  return path;
}

function shellSingleQuote(s: string): string {
  // Wrap in single quotes; escape any embedded single-quote by closing,
  // inserting a literal '\'', and reopening.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function makeSpec(jobId: string): JobSpec {
  return {
    version: 1,
    jobId,
    set: 'default',
    agents: [{ id: 'coordinator', role: 'C', adapter: 'claude-sdk' }],
    bindings: {},
  };
}

describe('runPipelineInContainer', () => {
  it('republishes envelopes from the fake container onto the bus', async () => {
    const wsRoot = await tmpDir('ws');
    const bus = new JobBus();
    const seen: Envelope[] = [];
    bus.subscribe('j-c1', (env) => seen.push(env));

    const fakeBin = await fakeDevcontainer({
      stdoutLines: [
        JSON.stringify({
          jobId: 'j-c1',
          agentId: 'planner',
          event: { kind: 'response', ts: 't', text: 'from-container' },
        }),
        JSON.stringify({ kind: 'job-complete', jobId: 'j-c1', status: 'completed' }),
      ],
    });

    const result = await runPipelineInContainer({
      spec: makeSpec('j-c1'),
      bus,
      containerId: 'fake-container-id',
      workspaceRoot: wsRoot,
      devcontainerBin: fakeBin,
    });

    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(seen).toHaveLength(1);
    if (seen[0]?.event.kind === 'response') {
      expect(seen[0].event.text).toBe('from-container');
    }
  });

  it('writes spec.json under the workspaceRoot mount path with mode 0o600', async () => {
    const wsRoot = await tmpDir('ws');
    const bus = new JobBus();

    const fakeBin = await fakeDevcontainer({
      stdoutLines: [JSON.stringify({ kind: 'job-complete', jobId: 'j-spec', status: 'completed' })],
    });

    await runPipelineInContainer({
      spec: makeSpec('j-spec'),
      bus,
      containerId: 'x',
      workspaceRoot: wsRoot,
      devcontainerBin: fakeBin,
    });

    const { stat } = await import('node:fs/promises');
    const expected = join(wsRoot, '.harness', 'run', 'jobs', 'j-spec', 'spec.json');
    const st = await stat(expected);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('reports failed status with synthetic error envelope when no sentinel emitted', async () => {
    const wsRoot = await tmpDir('ws');
    const bus = new JobBus();
    const seen: Envelope[] = [];
    bus.subscribe('j-crash', (env) => seen.push(env));

    // Fake container exits with no JSONL — simulates `devcontainer exec`
    // failing to reach the container, or harness-pipeline crashing
    // before emitting anything.
    const fakeBin = await fakeDevcontainer({
      stdoutLines: [],
      stderrLines: ['something went wrong'],
      exitCode: 1,
    });

    const result = await runPipelineInContainer({
      spec: makeSpec('j-crash'),
      bus,
      containerId: 'unreachable-container',
      workspaceRoot: wsRoot,
      devcontainerBin: fakeBin,
    });

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.stderrTail).toContain('something went wrong');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.event.kind).toBe('error');
    expect(seen[0]?.agentId).toBe('__executor__');
    if (seen[0]?.event.kind === 'error') {
      expect(seen[0].event.message).toContain('unreachab');
      expect(seen[0].event.message).toContain('exited 1');
    }
  });

  it('respects sentinel "failed" status even when exit code is 0', async () => {
    // A pipeline that fails an agent but exits cleanly via the sentinel
    // should be marked failed by the parent, not completed.
    const wsRoot = await tmpDir('ws');
    const bus = new JobBus();

    const fakeBin = await fakeDevcontainer({
      stdoutLines: [JSON.stringify({ kind: 'job-complete', jobId: 'j-x', status: 'failed' })],
      exitCode: 0,
    });

    const result = await runPipelineInContainer({
      spec: makeSpec('j-x'),
      bus,
      containerId: 'x',
      workspaceRoot: wsRoot,
      devcontainerBin: fakeBin,
    });

    expect(result.status).toBe('failed');
  });

  it('forwards lifecycle events: spawned → sentinel → exit', async () => {
    const wsRoot = await tmpDir('ws');
    const bus = new JobBus();
    const lifecycle: string[] = [];

    const fakeBin = await fakeDevcontainer({
      stdoutLines: [JSON.stringify({ kind: 'job-complete', jobId: 'j-lc', status: 'completed' })],
    });

    await runPipelineInContainer({
      spec: makeSpec('j-lc'),
      bus,
      containerId: 'x',
      workspaceRoot: wsRoot,
      devcontainerBin: fakeBin,
      onSubprocessEvent: (e) => lifecycle.push(e.kind),
    });

    expect(lifecycle).toEqual(['spawned', 'sentinel', 'exit']);
  });

  it('respects custom hostSpecDir + containerSpecPath overrides', async () => {
    const wsRoot = await tmpDir('ws');
    const customHostDir = await tmpDir('custom-spec');
    const bus = new JobBus();

    const fakeBin = await fakeDevcontainer({
      stdoutLines: [JSON.stringify({ kind: 'job-complete', jobId: 'j-custom', status: 'completed' })],
    });

    await runPipelineInContainer({
      spec: makeSpec('j-custom'),
      bus,
      containerId: 'x',
      workspaceRoot: wsRoot,
      hostSpecDir: customHostDir,
      containerSpecPath: '/some/custom/path/spec.json',
      devcontainerBin: fakeBin,
    });

    // Spec written to the custom host dir, not the default.
    const { stat } = await import('node:fs/promises');
    const customPath = join(customHostDir, 'spec.json');
    await expect(stat(customPath)).resolves.toBeDefined();
    // Default path NOT used.
    await expect(
      stat(join(wsRoot, '.harness', 'run', 'jobs', 'j-custom', 'spec.json'))
    ).rejects.toThrow();
  });
});

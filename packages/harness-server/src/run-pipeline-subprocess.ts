/**
 * runPipelineSubprocess — out-of-process pipeline executor (slice
 * 9d-1, the spawn primitive that 9d-2 will wrap with `devcontainer
 * up`).
 *
 * Responsibility: write the spec to a temp file, spawn the
 * harness-pipeline binary as a subprocess, parse JSONL envelopes from
 * its stdout, republish them onto the parent's JobBus, and await
 * exit. The contract this implements is the assembler/executor split
 * (`project_proxy_per_job_architecture`):
 *
 *   harness-server (assembler) ─ writes spec.json, owns JobBus
 *           │
 *           ▼ spawn(harness-pipeline, [specPath])
 *   harness-pipeline (executor) ─ reads spec.json, runs runJob,
 *           │                     emits JSONL envelopes on stdout
 *           ▼
 *   stdout pipe ─ JSONL ─ parent parses, republishes
 *
 * Why subprocess (this slice) before container (9d-2): the JSONL
 * envelope shape is what carries between the two processes regardless
 * of whether the executor lives in the same OS or in a Docker
 * container. Validating the contract with subprocess is fast (no
 * Docker dep), and 9d-2 only swaps the spawn primitive — the parsing
 * and republish logic are unchanged.
 *
 * Error handling:
 *   - Subprocess exit 0 → status 'completed'
 *   - Subprocess exit 1 → status 'failed' (job-level failure with
 *     sentinel)
 *   - Subprocess exit 2 → spec error (parent should not see this in
 *     practice — spec is parent-authored — but we surface it as
 *     'failed' with a stderr-tail error envelope)
 *   - Subprocess exit 3 → runtime error / panic; same as exit 2
 *   - Subprocess crashes / signal kill → 'failed' with synthetic
 *     error envelope
 *   - Non-JSON line on stdout → log to console.warn and skip; doesn't
 *     fail the run
 *
 * What this does NOT do:
 *   - Does not mutate the parent's JobRecord (the parent's JobBus
 *     subscribers — TokenAccumulator, SSE clients, TUI — handle that)
 *   - Does not spawn a container (9d-2)
 *   - Does not mount workspace volumes (9d-2)
 *   - Does not authenticate (the spec already carries resolved
 *     bindings)
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobBus } from '@agentx/harness-core';
import type { JobSpec } from '@agentx/harness-pipeline';
import { consumeJsonlStream } from './pipeline-jsonl-stream.ts';

export interface RunPipelineSubprocessOptions {
  spec: JobSpec;
  bus: JobBus;
  /**
   * Directory where spec.json gets written. Defaults to
   * `<os.tmpdir>/harness-pipeline/<jobId>`. The directory is created
   * with mode 0o700 (owner-only) since spec.bindings carry resolved
   * credentials.
   */
  specDir?: string;
  /**
   * Path to the runtime that executes bin.ts. Defaults to the
   * workspace's `tsx` binary. In production, will likely be `bun` or
   * `node` after build. Tests override to point at the workspace
   * tsx so child subprocesses can interpret .ts directly.
   */
  runtime?: string;
  /**
   * Path to the harness-pipeline bin.ts. Defaults to the workspace
   * checkout's source file (resolved relative to this module). In
   * 9d-2 (container path), this becomes a path inside the container.
   */
  binPath?: string;
  /**
   * Optional hook for tests / observers that want to know when
   * subprocess-level state changes (started, sentinel, exit). Pure
   * observation, no side effects.
   */
  onSubprocessEvent?: (event: SubprocessLifecycleEvent) => void;
}

export type SubprocessLifecycleEvent =
  | { kind: 'spawned'; pid: number }
  | { kind: 'sentinel'; status: string }
  | { kind: 'exit'; code: number; signal: NodeJS.Signals | null };

export interface RunPipelineSubprocessResult {
  /** Job-level status as reported by the executor's sentinel, or
   *  derived from the exit code if no sentinel was seen. */
  status: 'completed' | 'failed';
  /** Subprocess exit code. 0 = completed, 1 = job failed, 2-3 =
   *  spec/runtime error in the executor itself. */
  exitCode: number;
  /** Stderr tail captured during the run — empty for clean runs.
   *  Useful for diagnostics when the subprocess fails before emitting
   *  a sentinel. Capped at 4 KiB. */
  stderrTail: string;
}

/** Default workspace-relative path to the harness-pipeline binary
 *  source. Resolved at module load via import.meta.url so it works
 *  regardless of cwd. */
const DEFAULT_BIN_PATH = resolve(
  fileURLToPath(import.meta.url),
  '../../../harness-pipeline/src/bin.ts',
);

/** Default tsx binary path in the workspace's pnpm-managed
 *  node_modules/.bin. Tests + dev use this. Production deployments
 *  override to the runtime they ship with. */
const DEFAULT_RUNTIME = resolve(
  fileURLToPath(import.meta.url),
  '../../../../node_modules/.bin/tsx',
);

export async function runPipelineSubprocess(
  options: RunPipelineSubprocessOptions,
): Promise<RunPipelineSubprocessResult> {
  const { spec, bus } = options;
  const specDir = options.specDir ?? defaultSpecDir(spec.jobId);
  const runtime = options.runtime ?? DEFAULT_RUNTIME;
  const binPath = options.binPath ?? DEFAULT_BIN_PATH;

  // Step 1: write spec.json. Owner-only — credentials live inside.
  await mkdir(specDir, { recursive: true, mode: 0o700 });
  const specPath = join(specDir, 'spec.json');
  await writeFile(specPath, JSON.stringify(spec, null, 2), { mode: 0o600 });

  // Step 2: spawn the executor. stdio: pipe on all three so we can
  // read stdout (envelopes) + stderr (diagnostics) and the child can
  // ignore stdin.
  const child: ChildProcess = spawn(runtime, [binPath, specPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (typeof child.pid === 'number') {
    options.onSubprocessEvent?.({ kind: 'spawned', pid: child.pid });
  }

  // Step 3 + 4: shared JSONL parser handles stdout/stderr → bus
  // republish, sentinel detection, tail capture. Same logic for both
  // the tsx-subprocess path (here) and the devcontainer-exec path
  // (runPipelineInContainer). Resolves when both streams close.
  const streamPromise = consumeJsonlStream({
    stdout: child.stdout!,
    stderr: child.stderr!,
    bus,
    expectedJobId: spec.jobId,
    onSentinel: (sentinel) => {
      options.onSubprocessEvent?.({ kind: 'sentinel', status: sentinel.status });
    },
  });

  // Step 5: await child exit AND stream-drain in parallel. The exit
  // event fires first; the stream-drain may have a tiny lag while
  // pending buffer flushes.
  const exitPromise = new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolveP) => {
    child.on('close', (c, s) => resolveP({ code: c ?? 0, signal: s }));
  });
  const [{ code, signal }, { sentinel, stderrTail }] = await Promise.all([
    exitPromise,
    streamPromise,
  ]);
  options.onSubprocessEvent?.({ kind: 'exit', code, signal });

  // Step 6: derive final status. Sentinel wins when present (it's the
  // executor's authoritative report); otherwise map exit code to
  // 'failed' with a synthetic error envelope so the parent's
  // observers see the failure on the bus, not just in the result.
  if (sentinel) {
    return {
      status: sentinel.status === 'completed' ? 'completed' : 'failed',
      exitCode: code,
      stderrTail,
    };
  }

  bus.publish(spec.jobId, '__executor__', {
    kind: 'error',
    ts: new Date().toISOString(),
    message:
      `harness-pipeline subprocess exited ${code}` +
      (signal ? ` (signal ${signal})` : '') +
      (stderrTail ? `\nstderr tail:\n${stderrTail.trimEnd()}` : ''),
  });
  return { status: 'failed', exitCode: code, stderrTail };
}

function defaultSpecDir(jobId: string): string {
  // OS tmpdir; per-jobId subfolder so concurrent jobs don't collide.
  // The harness-server's own .harness/run/jobs/<id>/ would be a more
  // production-y place, but for v1 the spec is ephemeral — parent
  // owns the lifetime, and we don't need it after the subprocess
  // exits. Tests can override via specDir option.
  const tmpRoot = process.env.TMPDIR ?? '/tmp';
  return join(tmpRoot, 'harness-pipeline', jobId);
}

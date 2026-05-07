/**
 * runPipelineInContainer — third spawn shape for the harness-pipeline
 * executor (slice 9d-3).
 *
 * Spawn primitive comparison:
 *
 *   in-process runJob          (harness-core, today's local default)
 *   runPipelineSubprocess      (slice 9d-1, tsx bin.ts; same OS,
 *                               separate process; isolation but no
 *                               sandboxing)
 *   runPipelineInContainer     (this file, slice 9d-3; harness-pipeline
 *                               binary inside a devcontainer; full
 *                               filesystem + network isolation, real
 *                               worktree mounts, the production shape)
 *
 * All three feed bytes through `consumeJsonlStream` — the JSONL
 * envelope contract is unchanged across them. Only the spawn primitive
 * differs:
 *   - in-process: direct function call
 *   - subprocess: `tsx packages/harness-pipeline-cli/src/bin.ts <spec>`
 *   - container:  `devcontainer exec --container-id <id> bun harness-pipeline <spec-in-container>`
 *
 * Lifecycle: this function does NOT manage the container's lifetime.
 * `runWorker` (slice 9d-2) created the container; the caller is
 * responsible for tearing it down with `devcontainer rm` after
 * runPipelineInContainer returns. Splitting the lifecycle lets callers
 * keep a container alive across multiple pipeline invocations (warm
 * pool, reattach scenarios per `project_local_multijob_workflow`).
 *
 * Spec path convention: the workspace's `<root>/.harness/run/` is
 * bind-mounted into the container at `/root/.harness/run/` by the
 * override-config that spawn-worker.ts generates. So writing spec.json
 * on the host to `<root>/.harness/run/jobs/<jobId>/spec.json` makes it
 * appear in the container at `/root/.harness/run/jobs/<jobId>/spec.json`.
 * Caller can override either path via options for non-default mount
 * topologies.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobBus } from '@ecruz165/harness-core';
import type { JobSpec } from '@ecruz165/harness-pipeline';
import { consumeJsonlStream } from './pipeline-jsonl-stream.ts';
import type { SubprocessLifecycleEvent } from './run-pipeline-subprocess.ts';

export interface RunPipelineInContainerOptions {
  spec: JobSpec;
  bus: JobBus;
  /** Container ID returned by runWorker / `devcontainer up`. Required
   *  — this function does NOT spawn the container; the caller already
   *  owns its lifecycle. */
  containerId: string;
  /**
   * Workspace root on the host. Used to compute the default
   * `hostSpecDir` when not explicitly given. Must match what was
   * passed to spawn-worker so the bind mount lines up.
   */
  workspaceRoot: string;
  /**
   * Override where spec.json is written on the host. Default:
   * `<workspaceRoot>/.harness/run/jobs/<jobId>/`. The directory must
   * be reachable from the container's mount table — by convention
   * that's `<workspaceRoot>/.harness/run` mounted at
   * `/root/.harness/run` (spawn-worker.ts:124).
   */
  hostSpecDir?: string;
  /**
   * Path inside the container where the spec.json appears via the
   * bind mount. Default: `/root/.harness/run/jobs/<jobId>/spec.json`
   * (matches spawn-worker's mount target). Override only if the
   * worker image overrides the mount path.
   */
  containerSpecPath?: string;
  /**
   * Path to the devcontainer CLI binary on host. Default:
   * `devcontainer` resolved on PATH. Tests with a fixture container
   * can pass an absolute path.
   */
  devcontainerBin?: string;
  /**
   * In-container command name for the harness-pipeline binary.
   * Default: `harness-pipeline` (resolved on the container's PATH).
   * Override for fixture containers that don't have it installed —
   * e.g., `bun /workspace/packages/harness-pipeline-cli/src/bin.ts`.
   */
  pipelineCommand?: string;
  /** Hook for tests / observers. Mirrors runPipelineSubprocess. */
  onSubprocessEvent?: (event: SubprocessLifecycleEvent) => void;
}

export interface RunPipelineInContainerResult {
  status: 'completed' | 'failed';
  /** Exit code of the `devcontainer exec` invocation. 0 maps to the
   *  pipeline succeeding; non-zero maps to either pipeline failure
   *  (executor exit 1) or a devcontainer-level error (couldn't reach
   *  the container, exec failed to start, etc.). */
  exitCode: number;
  stderrTail: string;
}

export async function runPipelineInContainer(
  options: RunPipelineInContainerOptions,
): Promise<RunPipelineInContainerResult> {
  const { spec, bus, containerId, workspaceRoot } = options;
  const hostSpecDir =
    options.hostSpecDir ?? join(workspaceRoot, '.harness', 'run', 'jobs', spec.jobId);
  const containerSpecPath =
    options.containerSpecPath ?? `/root/.harness/run/jobs/${spec.jobId}/spec.json`;
  const devcontainerBin = options.devcontainerBin ?? 'devcontainer';
  const pipelineCommand = options.pipelineCommand ?? 'harness-pipeline';

  // Step 1: write spec.json on the host. The bind mount makes it
  // visible in the container at `containerSpecPath`. mode 0600
  // because spec.bindings carry resolved credentials.
  await mkdir(hostSpecDir, { recursive: true, mode: 0o700 });
  const hostSpecPath = join(hostSpecDir, 'spec.json');
  await writeFile(hostSpecPath, JSON.stringify(spec, null, 2), { mode: 0o600 });

  // Step 2: spawn `devcontainer exec`. stdio: pipe on stdout+stderr
  // so we can stream JSONL and capture diagnostics.
  // The pipelineCommand may contain spaces (e.g., "bun /path/to/bin.ts"),
  // so we split it into [program, ...args] and append the spec path.
  const cmdParts = pipelineCommand.split(/\s+/).filter((p) => p.length > 0);
  const child: ChildProcess = spawn(
    devcontainerBin,
    ['exec', '--container-id', containerId, ...cmdParts, containerSpecPath],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  if (typeof child.pid === 'number') {
    options.onSubprocessEvent?.({ kind: 'spawned', pid: child.pid });
  }

  // Step 3: shared JSONL parser — same as runPipelineSubprocess.
  const streamPromise = consumeJsonlStream({
    stdout: child.stdout!,
    stderr: child.stderr!,
    bus,
    expectedJobId: spec.jobId,
    onSentinel: (sentinel) => {
      options.onSubprocessEvent?.({ kind: 'sentinel', status: sentinel.status });
    },
  });

  const exitPromise = new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolveP) => {
    child.on('close', (c, s) => resolveP({ code: c ?? 0, signal: s }));
  });
  const [{ code, signal }, { sentinel, stderrTail }] = await Promise.all([
    exitPromise,
    streamPromise,
  ]);
  options.onSubprocessEvent?.({ kind: 'exit', code, signal });

  // Step 4: derive final status. Same rules as
  // runPipelineSubprocess; the only difference between the spawn
  // shapes is the transport, not the contract.
  if (sentinel) {
    return {
      status: sentinel.status === 'completed' ? 'completed' : 'failed',
      exitCode: code,
      stderrTail,
    };
  }

  // No sentinel — the exec died before the executor could finish.
  // Distinct possibilities:
  //   - container exited mid-run (OOM, kill, devcontainer rm race)
  //   - devcontainer exec couldn't reach the container
  //   - harness-pipeline binary not found in container PATH
  // Surface the failure on the bus so consumers see it.
  bus.publish(spec.jobId, '__executor__', {
    kind: 'error',
    ts: new Date().toISOString(),
    message:
      `harness-pipeline (in container ${containerId.slice(0, 12)}) exited ${code}` +
      (signal ? ` (signal ${signal})` : '') +
      (stderrTail ? `\nstderr tail:\n${stderrTail.trimEnd()}` : ''),
  });
  return { status: 'failed', exitCode: code, stderrTail };
}

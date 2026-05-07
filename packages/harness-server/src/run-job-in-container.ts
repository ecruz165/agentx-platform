/**
 * runJobInContainer — the integration layer that wires the slice 9d
 * primitives end-to-end (slice 9d-4).
 *
 * Sequence:
 *   1. Pre-resolve bindings — walk the JobRecord's agents, project
 *      each `accepts` list to a single ResolvedBinding via the
 *      injected resolver. The container's harness-pipeline reads
 *      these from spec.bindings and pre-builds adapters at boot;
 *      this is the "executor" side of the assembler/executor split.
 *   2. Build JobSpec — combine the registered agents + resolved
 *      bindings into the contract shape from `@ecruz165/harness-pipeline`.
 *   3. spawnWorker — generate worktrees + override-config artifacts
 *      (slice 9d-2 fix already runs `git fetch` on cached bare repos).
 *   4. runWorker — actually invoke `devcontainer up`; capture
 *      containerId.
 *   5. runPipelineInContainer — `devcontainer exec` the binary
 *      against the spec; stream JSONL envelopes back to the parent's
 *      JobBus.
 *   6. Cleanup — by default, leave the container running on success
 *      (F22: keep worktrees on success for diff inspection / PR
 *      opening) and remove on failure. Both policies overridable.
 *
 * Limitation vs in-process runJob:
 *   The container path pre-resolves ONE binding per agent (the first
 *   satisfiable). It does NOT carry the full accept-list into the
 *   container, so slice 13c's runtime fallback (BillingError →
 *   re-resolve next binding) doesn't apply inside the container.
 *   To restore fallback we'd either:
 *     (a) ship the full accept-list + broker into the container (rejects
 *         the assembler/executor split's auth boundary), OR
 *     (b) have runJobInContainer catch the failed status, re-resolve
 *         excluding the first binding, and respawn the executor —
 *         essentially fallback at the container layer instead of
 *         the agent-loop layer.
 *   Documented; pick when the use case arrives.
 *
 * Doesn't change today's POST /v1/jobs default (in-process runJob).
 * harness-server selects between the two paths via env flag — that
 * wiring lives in handleSubmitJob, not here.
 */

import { spawn } from 'node:child_process';
import type { BindingResolver, CredentialBroker, ResolvedBinding } from '@ecruz165/agent-auth';
import type { JobBus, JobRecord, RegisteredAgent } from '@ecruz165/harness-core';
import type { JobSpec, SpecAgent } from '@ecruz165/harness-pipeline';
import { runPipelineInContainer } from './run-pipeline-in-container.ts';
import { runWorker, type SpawnRepoSpec } from './spawn-worker.ts';

export interface RunJobInContainerOptions {
  jobId: string;
  jobs: Map<string, JobRecord>;
  bus: JobBus;
  broker: CredentialBroker;
  resolver: BindingResolver;
  /** Host workspace root — passed to spawnWorker for artifact paths
   *  AND to runPipelineInContainer for the spec.json mount source. */
  workspaceRoot: string;
  /** Per-product repo specs (cloneUrl + name). The catalog's
   *  ProductDef doesn't carry git repos today; the wire layer (POST
   *  /v1/jobs body OR an explicit workspace YAML lookup) provides
   *  them. */
  repos: SpawnRepoSpec[];
  productId: string;
  pipeline: string;
  /** Per-job submission's `set` (per memory `project_set_scoped_accepts`). */
  setName?: string;
  /** Forwarded to spawnWorker. See its doc — useful for injecting
   *  GITHUB_TOKEN or an alternate SSH key for non-default credentials. */
  cloneEnv?: NodeJS.ProcessEnv;
  /** Forwarded to spawnWorker (slice 9d-6). Mounts an SSH agent
   *  socket into the worker container so the worker's git pushes /
   *  PR creation can authenticate. `true` auto-detects from
   *  process.env.SSH_AUTH_SOCK; a string is the explicit host path;
   *  unset/false disables forwarding. */
  forwardSshAgent?: boolean | string;
  /** Forwarded to spawnWorker. Override the in-container path of the
   *  SSH agent socket. Default `/ssh-agent.sock`. Docker Desktop
   *  setups may prefer `/run/host-services/ssh-auth.sock`. */
  sshAgentContainerPath?: string;
  /** Forwarded to runWorker + runPipelineInContainer. Default
   *  `devcontainer` resolved on PATH. Tests pass an absolute path to
   *  a fixture script. */
  devcontainerBin?: string;
  /** Forwarded to runPipelineInContainer. Default `harness-pipeline`. */
  pipelineCommand?: string;
  /** F22 cleanup policy. Default keep-on-success / rm-on-failure. */
  removeContainerOnSuccess?: boolean;
  removeContainerOnFailure?: boolean;
  /** Path to docker binary used by the cleanup step. Default
   *  `docker` resolved on PATH. Tests inject a fixture script. */
  dockerBin?: string;
  /** Status-change hook mirroring runJob's contract. Fires for
   *  job-level transitions only (agent-level transitions happen
   *  inside the container; their envelopes flow over the bus). */
  onStatusChange?: (jobId: string, agentId: string | null, status: string) => void;
}

export interface RunJobInContainerResult {
  status: 'completed' | 'failed';
  containerId?: string;
  containerRemoved: boolean;
  /** Stderr tail captured from the executor exec call — empty for
   *  clean runs. Useful for diagnostics when the container died
   *  before emitting a sentinel. */
  stderrTail: string;
}

export async function runJobInContainer(
  opts: RunJobInContainerOptions,
): Promise<RunJobInContainerResult> {
  const job = opts.jobs.get(opts.jobId);
  if (!job) {
    throw new Error(`runJobInContainer: jobId ${opts.jobId} not in jobs map`);
  }

  // Step 1+2: pre-resolve bindings and build the JobSpec. Synthetic
  // coordinators (entry/checkout) get no binding — same as in-process
  // runJob, which skips them by id.
  const spec = await buildJobSpec({
    job,
    jobId: opts.jobId,
    productId: opts.productId,
    pipeline: opts.pipeline,
    setName: opts.setName ?? 'default',
    resolver: opts.resolver,
  });

  // Job-level transition: 'running'. Mirrors runJob's onStatusChange
  // contract so consumers don't need to know which path runs the job.
  job.status = 'running';
  opts.onStatusChange?.(opts.jobId, null, 'running');

  // Step 3+4: spawnWorker artifacts + runWorker (devcontainer up).
  // Failures here mean the container never started — surface as
  // job-level error envelope + failed status.
  let containerId: string;
  let stderrTail = '';
  try {
    const worker = await runWorker({
      spec: {
        jobId: opts.jobId,
        productId: opts.productId,
        pipeline: opts.pipeline,
        ...(job.name ? { name: job.name } : {}),
        repos: opts.repos,
        workspaceRoot: opts.workspaceRoot,
        ...(opts.cloneEnv ? { cloneEnv: opts.cloneEnv } : {}),
        ...(opts.forwardSshAgent !== undefined ? { forwardSshAgent: opts.forwardSshAgent } : {}),
        ...(opts.sshAgentContainerPath
          ? { sshAgentContainerPath: opts.sshAgentContainerPath }
          : {}),
      },
      ...(opts.devcontainerBin ? { devcontainerBin: opts.devcontainerBin } : {}),
    });
    containerId = worker.containerId;
  } catch (err) {
    opts.bus.publish(opts.jobId, '__executor__', {
      kind: 'error',
      ts: new Date().toISOString(),
      message: `container spawn failed: ${(err as Error).message}`,
    });
    job.status = 'failed';
    opts.onStatusChange?.(opts.jobId, null, 'failed');
    return { status: 'failed', containerRemoved: false, stderrTail: '' };
  }

  // Step 5: run the pipeline inside the container.
  let status: 'completed' | 'failed' = 'failed';
  try {
    const result = await runPipelineInContainer({
      spec,
      bus: opts.bus,
      containerId,
      workspaceRoot: opts.workspaceRoot,
      ...(opts.devcontainerBin ? { devcontainerBin: opts.devcontainerBin } : {}),
      ...(opts.pipelineCommand ? { pipelineCommand: opts.pipelineCommand } : {}),
    });
    status = result.status;
    stderrTail = result.stderrTail;
  } finally {
    job.status = status;
    opts.onStatusChange?.(opts.jobId, null, status);
  }

  // Step 6: cleanup per F22.
  const removeOnSuccess = opts.removeContainerOnSuccess ?? false;
  const removeOnFailure = opts.removeContainerOnFailure ?? true;
  const shouldRemove =
    (status === 'completed' && removeOnSuccess) || (status === 'failed' && removeOnFailure);
  let containerRemoved = false;
  if (shouldRemove) {
    try {
      await removeContainer(containerId, opts.dockerBin);
      containerRemoved = true;
    } catch (err) {
      // Surface but don't escalate — the job's status is already set.
      opts.bus.publish(opts.jobId, '__executor__', {
        kind: 'error',
        ts: new Date().toISOString(),
        message: `container cleanup failed: ${(err as Error).message}`,
      });
    }
  }

  return { status, containerId, containerRemoved, stderrTail };
}

/**
 * Project the JobRecord's agents to SpecAgents and resolve each
 * agent's accept-list to a single ResolvedBinding. Synthetic agents
 * (coordinator / checkout-coordinator) get no binding — they're
 * skipped by runJob inside the container.
 *
 * Exported for tests + for the harness-server flow that may want to
 * pre-build the spec without actually running it (dry-run mode,
 * inspection endpoints).
 */
export async function buildJobSpec(args: {
  job: JobRecord;
  jobId: string;
  productId: string;
  pipeline: string;
  setName: string;
  resolver: BindingResolver;
}): Promise<JobSpec> {
  const bindings: Record<string, ResolvedBinding> = {};
  const specAgents: SpecAgent[] = [];

  for (const agent of args.job.agents) {
    if (isSyntheticAgent(agent.id)) {
      specAgents.push(toSpecAgent(agent));
      continue;
    }
    if (!agent.accepts || agent.accepts.length === 0) {
      // No binding declared; the container's runJob will fall through
      // to the legacy adapter-id factory inside harness-pipeline.
      specAgents.push(toSpecAgent(agent));
      continue;
    }
    const binding = await args.resolver.resolveBinding(agent.accepts);
    bindings[agent.id] = binding;
    specAgents.push({ ...toSpecAgent(agent), bindingId: agent.id });
  }

  return {
    version: 1,
    jobId: args.jobId,
    pipeline: args.pipeline,
    productId: args.productId,
    set: args.setName,
    ...(args.job.name ? { name: args.job.name } : {}),
    ...(args.job.input ? { input: args.job.input } : {}),
    ...(args.job.productRepos ? { productRepos: args.job.productRepos } : {}),
    agents: specAgents,
    bindings,
  };
}

function isSyntheticAgent(id: string): boolean {
  return id === 'coordinator' || id === 'checkout-coordinator';
}

function toSpecAgent(agent: RegisteredAgent): SpecAgent {
  return {
    id: agent.id,
    role: agent.role,
    adapter: agent.adapter,
    ...(agent.systemPrompt !== undefined ? { systemPrompt: agent.systemPrompt } : {}),
    ...(agent.config !== undefined ? { config: agent.config } : {}),
  };
}

/**
 * Remove a Docker container by id. Uses `docker rm -f` directly —
 * devcontainer-cli doesn't expose an `rm` subcommand, and forcing
 * removal handles the case where the container is still running
 * (e.g., after a job failure that didn't clean up its child
 * processes inside).
 *
 * Exported for tests.
 */
export function removeContainer(containerId: string, dockerBin = 'docker'): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(dockerBin, ['rm', '-f', containerId], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', rejectP);
    child.on('close', (code) => {
      if (code !== 0) {
        rejectP(new Error(`docker rm -f ${containerId} exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolveP();
    });
  });
}

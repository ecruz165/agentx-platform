/**
 * @agentx/harness-pipeline — the per-job runtime that executes one pipeline
 * job inside a harness-pipeline devcontainer.
 *
 * Per memory `project_proxy_per_job_architecture`:
 *   - harness-server (always-on) reads catalog + auth.json, resolves bindings,
 *     writes spec.json, spawns this runtime
 *   - This package (per-job, in container) reads spec.json, builds adapters
 *     from pre-resolved bindings, runs runJob from harness-core, exits
 *
 * The auth boundary is sharp: this runtime has no FileBroker, no resolver,
 * no access to ~/.agentx/auth.json. It receives credentials only through
 * spec.bindings, which harness-server populated.
 *
 * v1 phase 1 (this slice): in-process exposure of `runHarnessPipeline(spec)`.
 * Container entrypoint (`bin.ts`) and harness-server integration land in
 * follow-up slices once this contract is exercised by tests.
 */

import {
  bindingToAdapter,
  type AgentAdapter,
  type BindingToAdapterOptions,
} from '@agentx/agent-adapter';
import {
  JobBus,
  runJob,
  type Envelope,
  type JobRecord,
  type RegisteredAgent,
} from '@agentx/harness-core';
import { SpecBroker } from './spec-broker.ts';
import type { JobSpec, SpecAgent } from './spec.ts';

export {
  parseJobSpec,
  JobSpecError,
  type JobSpec,
  type SpecAgent,
} from './spec.ts';
export { SpecBroker } from './spec-broker.ts';

export interface RunHarnessPipelineOptions {
  /**
   * Forwarded to `bindingToAdapter` as `options.localEndpoint`. The
   * harness-pipeline runtime (or its tests) determines local-provider
   * endpoints; the spec doesn't carry them. Defaults to env-var lookup
   * inside `bindingToAdapter`.
   */
  localEndpoint?: BindingToAdapterOptions['localEndpoint'];
  /**
   * Optional bus override for tests / external observers. When omitted, a
   * fresh JobBus is created and exposed on the result.
   */
  bus?: JobBus;
  /**
   * Hook for tests. Fires on every status transition the orchestrator
   * makes — agent transitions get (jobId, agentId, status), job-level
   * transitions get (jobId, null, status). Pure observation, no
   * side effects.
   */
  onStatusChange?: (jobId: string, agentId: string | null, status: string) => void;
}

export interface RunHarnessPipelineResult {
  /** Final job status after orchestration ends. `'completed' | 'failed'` in
   *  the steady state. */
  status: string;
  /** The mutated job record — agents have their final statuses. */
  job: JobRecord;
  /** The bus the orchestrator wrote events to. Useful for tests that want
   *  to assert on event sequences. */
  bus: JobBus;
  /** All Envelopes published during the run, in publish order. Pulled from
   *  the bus via subscription before runJob starts. Tests can inspect this
   *  without setting up their own subscriber. */
  events: Envelope[];
}

/**
 * Run a single pipeline job from a JobSpec.
 *
 * The spec must already be parsed/validated (via `parseJobSpec`); this
 * function does no further validation of the spec shape. It does, however,
 * assert that every agent referencing a `bindingId` has a real binding to
 * resolve to — that's a structural invariant the spec parser enforces, but
 * we re-check at adapter-build time so the failure mode is loud, not "no
 * adapter for agent X".
 */
export async function runHarnessPipeline(
  spec: JobSpec,
  options: RunHarnessPipelineOptions = {}
): Promise<RunHarnessPipelineResult> {
  // Step 1: build the broker from pre-resolved credentials.
  const broker = new SpecBroker(spec.bindings);

  // Step 2: pre-construct adapters for every agent that has a binding.
  // Agents without a binding (e.g., placeholder coordinators) don't get
  // an adapter — the orchestrator skips them by id today, and any future
  // synthetic-agent execution path will route through a different
  // mechanism.
  const adapters = new Map<string, AgentAdapter>();
  for (const agent of spec.agents) {
    if (!agent.bindingId) continue;
    const binding = spec.bindings[agent.bindingId];
    if (!binding) {
      throw new Error(
        `runHarnessPipeline: agent "${agent.id}" has bindingId "${agent.bindingId}" ` +
          `but no such binding in spec.bindings (the spec parser should have caught this)`
      );
    }
    const adapter = bindingToAdapter(binding, {
      broker,
      localEndpoint: options.localEndpoint,
    });
    adapters.set(agent.id, adapter);
  }

  // Step 3: build the JobRecord the orchestrator will mutate.
  const registeredAgents: RegisteredAgent[] = spec.agents.map(toRegisteredAgent);
  const job: JobRecord = {
    jobId: spec.jobId,
    pipeline: spec.pipeline,
    productId: spec.productId,
    productRepos: spec.productRepos,
    name: spec.name,
    input: spec.input,
    submittedAt: new Date().toISOString(),
    status: 'received',
    agents: registeredAgents,
  };
  const jobs = new Map<string, JobRecord>([[spec.jobId, job]]);

  // Step 4: bus + event capture. Subscribing before runJob means we don't
  // miss the initial 'running' transition.
  const bus = options.bus ?? new JobBus();
  const events: Envelope[] = [];
  const unsubscribe = bus.subscribe(spec.jobId, (env) => events.push(env));

  // Step 5: run the orchestrator. Pre-built adapters take the highest
  // priority path in the orchestrator's `constructAgentAdapter`, so the
  // resolver/factory paths are never reached for these agents.
  try {
    await runJob(spec.jobId, {
      jobs,
      bus,
      broker,
      adapters,
      onStatusChange: options.onStatusChange,
    });
  } finally {
    unsubscribe();
  }

  return {
    status: job.status,
    job,
    bus,
    events,
  };
}

/** Project a SpecAgent (from spec.json) to a RegisteredAgent (in-memory
 *  orchestration record). The status starts at 'pending'; bindingId is
 *  carried into RegisteredAgent.config under a reserved key for
 *  observability — the orchestrator's adapter path uses adapters[agent.id]
 *  directly, but downstream readers (TUI, telemetry) may want to know
 *  which binding fed each agent. */
function toRegisteredAgent(agent: SpecAgent): RegisteredAgent {
  return {
    id: agent.id,
    role: agent.role,
    adapter: agent.adapter,
    systemPrompt: agent.systemPrompt,
    config: agent.config,
    status: 'pending',
  };
}

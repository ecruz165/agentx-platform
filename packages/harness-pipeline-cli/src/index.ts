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
  type AgentAdapter,
  type BindingToAdapterOptions,
  bindingNeedsOpenCode,
  bindingToAdapter,
  defaultLocalEndpointResolver,
  OpenCodeServer,
  type OpenCodeServerOptions,
  type OpencodeProviderEntry,
} from '@agentx/agent-adapter';
import type { ResolvedBinding } from '@agentx/agent-auth';
import {
  type Envelope,
  JobBus,
  type JobRecord,
  type RegisteredAgent,
  runJob,
} from '@agentx/harness-core';
import type { JobSpec, SpecAgent } from './spec.ts';
import { SpecBroker } from './spec-broker.ts';

export {
  type JobSpec,
  JobSpecError,
  parseJobSpec,
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
   * URL of an externally-managed `opencode serve` instance. When provided,
   * runHarnessPipeline does NOT spawn its own opencode-server even if the
   * spec needs one — the caller owns the lifecycle. Useful for tests, for
   * pre-warmed pools, and for cases where multiple jobs share a server.
   *
   * When omitted, runHarnessPipeline scans the spec via
   * `bindingNeedsOpenCode` and spawns its own server if (and only if)
   * any agent needs it — per memory `project_lazy_resource_acquisition`.
   * Pure-anthropic pipelines pay no opencode cost.
   */
  opencodeServerUrl?: string;
  /**
   * Forwarded to the internally-spawned OpenCodeServer when
   * runHarnessPipeline owns the lifecycle (i.e., opencodeServerUrl is
   * unset). Used to tune startup timeout / port for tests.
   */
  opencodeServer?: OpenCodeServerOptions;
  /**
   * Tmux socket path. When set AND runHarnessPipeline owns the
   * opencode-server lifecycle (i.e., opencodeServerUrl is unset), the
   * server is spawned inside a detached tmux session named
   * `opencode-server` on this socket. Output is tee'd to a logfile;
   * developers can read live with `tmux -S <socket> attach -t
   * opencode-server -r`. Per memory `project_pipeline_tmux_topology`.
   *
   * When unset, opencode-server is spawned directly (no tmux). Existing
   * test paths and non-container production deployments stay unchanged.
   */
  tmuxSocket?: string;
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
  /** True when runHarnessPipeline started its own opencode-server for this
   *  job (i.e., the spec needed one and the caller did not provide a URL).
   *  Useful for tests to assert lazy-acquisition decisions. */
  opencodeServerStarted: boolean;
}

/**
 * Returns true if any binding in the spec resolves to OpenCodeCliAdapter —
 * meaning a running `opencode serve` is needed. Pure-anthropic pipelines
 * return false; mixed or fully-local pipelines return true.
 *
 * Exported for tests + for harness-server (which uses the same predicate
 * to decide whether to start its own coordinator-scoped opencode-server).
 */
export function specNeedsOpenCode(spec: JobSpec): boolean {
  for (const binding of Object.values(spec.bindings)) {
    if (bindingNeedsOpenCode(binding)) return true;
  }
  return false;
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
  options: RunHarnessPipelineOptions = {},
): Promise<RunHarnessPipelineResult> {
  // Step 1: build the broker from pre-resolved credentials.
  const broker = new SpecBroker(spec.bindings);

  // Step 2: lazy-acquire opencode-server. Per memory
  // `project_lazy_resource_acquisition`: spawn ONLY if at least one
  // binding actually routes to OpenCodeCliAdapter. Caller can also
  // provide a URL to bypass this (pre-warmed pool, test fixture, etc.).
  // When `tmuxSocket` is set, the spawn happens inside a detached tmux
  // session for developer peek-ability (`project_pipeline_tmux_topology`).
  let ownedServer: OpenCodeServer | null = null;
  let opencodeServerUrl = options.opencodeServerUrl;
  if (!opencodeServerUrl && specNeedsOpenCode(spec)) {
    // Derive the provider config the server needs to know about — for
    // every local binding in the spec, register the provider id +
    // endpoint + the model id with opencode. Without this the server
    // boots with only built-in providers (anthropic, openai, github-
    // copilot, opencode), so `--attach` calls for `local-qwen/...` get
    // ProviderModelNotFoundError. (Cloud bindings to openai/google use
    // opencode's built-in providers — no derivation needed for those.)
    const localEndpoint = options.localEndpoint ?? defaultLocalEndpointResolver;
    const derivedProviders = deriveOpencodeProviders(spec.bindings, localEndpoint);
    ownedServer = new OpenCodeServer();
    const serverOpts: OpenCodeServerOptions = {
      ...(options.opencodeServer ?? {}),
      ...(Object.keys(derivedProviders).length > 0 ? { providers: derivedProviders } : {}),
      ...(options.tmuxSocket ? { tmuxSocket: options.tmuxSocket } : {}),
    };
    const handle = await ownedServer.start(serverOpts);
    opencodeServerUrl = handle.url;
  }

  try {
    // Step 3: pre-construct adapters for every agent that has a binding.
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
            `but no such binding in spec.bindings (the spec parser should have caught this)`,
        );
      }
      const adapter = bindingToAdapter(binding, {
        broker,
        localEndpoint: options.localEndpoint,
        ...(opencodeServerUrl ? { opencodeServerUrl } : {}),
      });
      adapters.set(agent.id, adapter);
    }

    // Step 4: build the JobRecord the orchestrator will mutate.
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

    // Step 5: bus + event capture. Subscribing before runJob means we
    // don't miss the initial 'running' transition.
    const bus = options.bus ?? new JobBus();
    const events: Envelope[] = [];
    const unsubscribe = bus.subscribe(spec.jobId, (env) => events.push(env));

    // Step 6: run the orchestrator. Pre-built adapters take the highest
    // priority path in the orchestrator's `constructAgentAdapter`, so
    // the resolver/factory paths are never reached for these agents.
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
      opencodeServerStarted: ownedServer !== null,
    };
  } finally {
    // Step 7: teardown owned resources (caller-provided server stays
    // alive; we only kill what we started). Per memory
    // `project_lazy_resource_acquisition`, this is symmetric reverse-
    // order — once tmux composition lands (slice 9c-2), tmux sessions
    // will be killed before the server.
    if (ownedServer) {
      await ownedServer.kill();
    }
  }
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

/**
 * Walk spec.bindings and produce the provider config the opencode-server
 * needs to know about. For each LOCAL binding, register the provider id
 * with its baseURL + the model id under `models`. Cloud bindings (openai
 * / google) use opencode's built-in providers and need no entry here.
 *
 * Multiple agents using the same local provider with different models
 * are merged: one provider entry, all model ids registered under
 * `models`. (Same auth applies to any local-qwen model — there's no
 * model-scoped auth on a custom OpenAI-compatible endpoint.)
 *
 * Exported for tests + external callers (the harness-server's
 * coordinator-scoped opencode-server uses the same shape).
 */
export function deriveOpencodeProviders(
  bindings: Record<string, ResolvedBinding>,
  localEndpoint: (providerId: string) => string | undefined,
): Record<string, OpencodeProviderEntry> {
  const providers: Record<string, OpencodeProviderEntry> = {};
  for (const binding of Object.values(bindings)) {
    if (binding.kind !== 'local') continue;
    const endpoint = localEndpoint(binding.provider.id);
    if (!endpoint) continue;
    const modelId = binding.model.vendorModelId ?? binding.model.id;
    const existing = providers[binding.provider.id];
    if (existing) {
      // Same provider, additional model — register it.
      existing.models ??= {};
      existing.models[modelId] = {};
    } else {
      providers[binding.provider.id] = {
        options: { baseURL: endpoint, apiKey: 'no-auth-required' },
        models: { [modelId]: {} },
      };
    }
  }
  return providers;
}

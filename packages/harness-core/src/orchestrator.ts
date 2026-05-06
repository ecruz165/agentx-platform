import {
  AdapterError,
  ClaudeSdkAdapter,
  OpenCodeCliAdapter,
  bindingToAdapter,
  type AgentAdapter,
  type BindingToAdapterOptions,
  type OpenCodeCliAdapterOptions,
} from '@agentx/agent-adapter';
import type {
  BindingResolver,
  CredentialBroker,
  ResolvedBinding,
} from '@agentx/agent-auth-lib';
import type { AdapterId } from './catalog.ts';
import { bridgeAdapter, type JobBus } from './job-bus.ts';
import type { JobRecord, RegisteredAgent } from './job.ts';

/**
 * Default set of AdapterError subclasses that trigger fall-through to
 * the next accept-list binding when an agent doesn't declare its own
 * `fallbackOn`. Excludes AuthError + ConfigError because those signal
 * structural problems (revoked key, model not in catalog) where silent
 * cross-provider retry is usually the wrong action — operators should
 * be notified, not papered over.
 *
 * Catalog authors who want either behavior — full retry on every
 * AdapterError, or stricter "billing only" — opt in by setting
 * `fallbackOn` explicitly on the AgentDef.
 *
 * Exported so harness-pipeline / catalog tooling can introspect it
 * (e.g., the TUI's "what would happen on error?" display).
 */
export const DEFAULT_FALLBACK_ERRORS: readonly string[] = Object.freeze([
  'BillingError',
  'RateLimitError',
  'NetworkError',
  'ProviderError',
]);

/**
 * Constructs the concrete adapter for an agent's `adapter` id, with the
 * credential broker injected. Pulled out into a factory so tests can swap
 * in mock adapters without monkeypatching the SDK.
 *
 * The optional `config` arg is the per-agent `AgentDef.config` from the
 * catalog — used to pass adapter-specific options (e.g., a local endpoint
 * URL for opencode-cli pointed at a self-hosted LLM).
 */
export type AdapterFactory = (
  adapterId: AdapterId,
  broker: CredentialBroker,
  config?: Record<string, unknown>
) => AgentAdapter;

export const defaultAdapterFactory: AdapterFactory = (id, broker, config) => {
  if (id === 'claude-sdk') return new ClaudeSdkAdapter({ broker });
  if (id === 'opencode-cli') {
    // Coerce: the catalog-side config is open-ended; the adapter accepts a
    // typed subset. Unknown keys are ignored by the adapter constructor.
    const cfg = (config ?? {}) as Partial<OpenCodeCliAdapterOptions>;
    return new OpenCodeCliAdapter({ broker, ...cfg });
  }
  throw new Error(`unknown adapter id: ${id}`);
};

export interface RunJobDeps {
  jobs: Map<string, JobRecord>;
  bus: JobBus;
  broker: CredentialBroker;
  adapterFactory?: AdapterFactory;
  /**
   * Optional binding resolver. When supplied AND the agent declares a
   * non-empty `accepts` list, the orchestrator resolves the accept-list
   * against this resolver and constructs the adapter via
   * `bindingToAdapter` instead of the legacy `adapterFactory`. When the
   * agent has no `accepts`, the resolver is unused — preserves backwards
   * compatibility for catalogs that haven't migrated.
   *
   * Per memory `project_per_worker_model_subscription`: this is the path
   * that lets a summarizer prefer `local-qwen:qwen3` while a code-reviewer
   * holds out for `anthropic:claude-haiku-4-5` in the same pipeline.
   */
  resolver?: BindingResolver;
  /**
   * Optional override for how local-provider endpoints are resolved when
   * `bindingToAdapter` returns a local binding. Forwarded to
   * `bindingToAdapter` as `options.localEndpoint`. Defaults to env-var
   * lookup (`AGENTX_LOCAL_QWEN_ENDPOINT` etc.).
   */
  localEndpoint?: BindingToAdapterOptions['localEndpoint'];
  /**
   * Optional pre-built adapters keyed by agent id. When set AND the lookup
   * returns a value, the orchestrator uses that adapter directly — bypasses
   * both the resolver path and the legacy adapterFactory path.
   *
   * Used by `@agentx/harness-pipeline` (the per-job container runtime),
   * which receives pre-resolved bindings via spec.json and constructs
   * adapters once at startup. The orchestrator inside the container then
   * looks them up by id rather than re-resolving — the auth boundary is
   * sharp: the container has no broker, no resolver, just adapters that
   * were pre-built by code with the right credentials.
   *
   * Per memory `project_proxy_per_job_architecture`: this is the
   * "executor" side of the assembler/executor split. harness-server
   * (assembler) resolves bindings and writes spec.json; harness-pipeline
   * (executor) reads spec.json, builds adapters, and runs runJob with this
   * field populated.
   */
  adapters?: Map<string, AgentAdapter>;
  /**
   * Optional override for the resolver-path adapter constructor. Defaults
   * to `bindingToAdapter` from `@agentx/agent-adapter`. Tests inject this
   * to substitute mock adapters per ResolvedBinding without spawning real
   * SDK clients — important for slice 13c fallback tests, where each
   * candidate must produce a controllable success/failure.
   */
  bindingToAdapterFn?: (
    binding: ResolvedBinding,
    options: BindingToAdapterOptions
  ) => AgentAdapter;
  /** Hook for tests / future telemetry. Fires on every status transition. */
  onStatusChange?: (jobId: string, agentId: string | null, status: string) => void;
}

/**
 * Phase 6 minimal sequential orchestrator.
 *
 * Walks the job's registered agents in declaration order (skipping the
 * synthetic coordinator), constructs each adapter via the factory, bridges
 * its event source onto the JobBus, and invokes it. The output of each
 * agent becomes the user prompt for the next agent.
 *
 * Failure semantics: fail-fast. The first agent to throw stops the pipeline;
 * the failed agent is marked `failed`, the job is marked `failed`, and any
 * remaining agents stay `pending`.
 *
 * State updates mutate the JobRecord in place — the in-memory `jobs` map
 * holds references, so subsequent GET /v1/jobs/:id calls observe the new
 * status without polling the orchestrator.
 *
 * NOT in scope here (deferred to MVP-3+ orchestrator):
 *   - DAG / parallel execution (`dependsOn`)
 *   - retries with backoff
 *   - HITL injection points
 *   - SQLite persistence of agent transitions
 *   - per-agent timeouts beyond what the adapter enforces
 *   - structured inter-agent message passing (currently raw string concat
 *     of prior output as the next user prompt)
 */
export async function runJob(jobId: string, deps: RunJobDeps): Promise<void> {
  const job = deps.jobs.get(jobId);
  if (!job) return;

  const factory = deps.adapterFactory ?? defaultAdapterFactory;
  job.status = 'running';
  deps.onStatusChange?.(jobId, null, 'running');

  let priorOutput = job.input ?? '';

  for (const agent of job.agents) {
    // Skip the synthetic coordinators — both are placeholder agents
    // owned by harness-server (entry: pipeline-routing decision;
    // exit: harvest+distill+promote). Their adapter binding is
    // declarative-only today; when they become real LLM-driven agents
    // this skip rule moves into config (e.g., a `synthetic: true`
    // flag on AgentDef) so the orchestrator can decide to skip vs run
    // based on declared capability rather than hardcoded ids.
    if (agent.id === 'coordinator' || agent.id === 'checkout-coordinator') continue;

    agent.status = 'running';
    deps.onStatusChange?.(jobId, agent.id, 'running');

    // Build the candidate list. For pre-built / factory / single-shot
    // resolver paths this is a one-element list; for the
    // `resolveAllBindings` path it can hold multiple bindings, in which
    // case any AdapterError thrown by candidate N falls through to N+1.
    let candidates: AgentCandidate[];
    try {
      candidates = await buildCandidates(agent, deps, factory);
    } catch (err) {
      // Eager construction failure (e.g., resolveAllBindings threw).
      // Treat as the same shape as the existing single-shot construction
      // failure — synthetic error event + agent/job marked failed.
      failAgent(jobId, agent, job, deps, `adapter construction failed: ${(err as Error).message}`);
      return;
    }

    const outcome = await runCandidates(candidates, agent, priorOutput, deps, jobId);
    if (outcome.kind === 'success') {
      priorOutput = outcome.result;
      agent.status = 'completed';
      deps.onStatusChange?.(jobId, agent.id, 'completed');
      continue;
    }
    // Failure — already-published error events are emitted by the bridged
    // adapter on invoke-failures; only emit a synthetic one for the
    // construction-failure case (parity with the pre-13c behavior).
    if (outcome.kind === 'construction-failure') {
      deps.bus.publish(jobId, agent.id, {
        kind: 'error',
        ts: new Date().toISOString(),
        message: `adapter construction failed: ${(outcome.error as Error).message}`,
      });
    }
    agent.status = 'failed';
    job.status = 'failed';
    deps.onStatusChange?.(jobId, agent.id, 'failed');
    deps.onStatusChange?.(jobId, null, 'failed');
    return;
  }

  job.status = 'completed';
  deps.onStatusChange?.(jobId, null, 'completed');
}

/**
 * One viable adapter source for an agent. Construction is deferred (a thunk)
 * so resolver-path candidates only build their adapter when actually invoked
 * — no work spent on bindings 2..N if binding 1 succeeds.
 *
 * `fallbackEligible` is the slice 13c switch: only resolver-path candidates
 * with siblings in the list will fall through on AdapterError. Pre-built
 * (executor-side) and legacy-factory paths are one-shot — the choice was
 * made by the assembler, not us, so fail-fast is the right semantic.
 */
interface AgentCandidate {
  /** Human-readable label for diagnostics. Embedded in the bus error
   *  event when fallback fires. */
  label: string;
  fallbackEligible: boolean;
  build: () => Promise<AgentAdapter>;
}

type CandidateOutcome =
  | { kind: 'success'; result: string }
  | { kind: 'construction-failure'; error: unknown }
  | { kind: 'invoke-failure'; error: unknown };

/**
 * Walk the candidate list, invoking each in priority order. Stops on the
 * first success. On AdapterError thrown by a fallback-eligible candidate
 * (and there's a next one), publishes an info-level error event and
 * continues. Anything else (non-AdapterError, or the last candidate, or
 * non-eligible) is terminal.
 */
async function runCandidates(
  candidates: readonly AgentCandidate[],
  agent: RegisteredAgent,
  userInput: string,
  deps: RunJobDeps,
  jobId: string
): Promise<CandidateOutcome> {
  let lastError: unknown;
  let lastWasConstruction = false;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const isLast = i + 1 >= candidates.length;

    // Build the adapter for this candidate. Construction failures are
    // never fallback-eligible — if we couldn't even instantiate it, the
    // binding is structurally broken and there's no point retrying it.
    // But the NEXT candidate might still work, so we continue iterating.
    let adapter: AgentAdapter;
    try {
      adapter = await candidate.build();
    } catch (err) {
      lastError = err;
      lastWasConstruction = true;
      if (!isLast && candidate.fallbackEligible) {
        deps.bus.publish(jobId, agent.id, {
          kind: 'error',
          ts: new Date().toISOString(),
          message: `${candidate.label} construction failed: ${(err as Error).message} — falling back to next binding`,
        });
        continue;
      }
      // Terminal — but only emit a synthetic error from the OUTER caller
      // when this is the only path the agent ever tried. If we tried
      // earlier candidates and bridged their adapter events, the bus
      // already has context; the outer caller doesn't double-emit on
      // invoke-failure path. For construction-only failures, the outer
      // caller handles the synthetic emit.
      return { kind: 'construction-failure', error: err };
    }

    // Bridge events for THIS adapter. Each candidate gets its own bridge
    // window so events appear chronologically in the bus.
    const detach = bridgeAdapter(deps.bus, jobId, agent.id, adapter.events);
    try {
      const result = await adapter.invoke({
        system: agent.systemPrompt,
        user: userInput,
      });
      detach();
      return { kind: 'success', result };
    } catch (err) {
      detach();
      lastError = err;
      lastWasConstruction = false;

      // Slice 13c: fall through on classified AdapterError only AND
      // when the agent's `fallbackOn` policy admits this specific
      // error class. Plain Error / non-classified failures stay
      // terminal so the pre-existing fail-fast semantic for
      // non-resolver paths is preserved.
      const fallbackPolicy = agent.fallbackOn ?? DEFAULT_FALLBACK_ERRORS;
      const errorName = err instanceof AdapterError ? err.name : '';
      const policyAdmits =
        fallbackPolicy.includes(errorName) ||
        // 'AdapterError' acts as a wildcard — any classified error.
        // Lets catalog authors opt in to "any AdapterError falls
        // through" without having to enumerate every subclass.
        fallbackPolicy.includes('AdapterError');
      if (!isLast && candidate.fallbackEligible && err instanceof AdapterError && policyAdmits) {
        deps.bus.publish(jobId, agent.id, {
          kind: 'error',
          ts: new Date().toISOString(),
          message: `${candidate.label} failed (${(err as AdapterError).name}): ${(err as Error).message} — falling back to next binding`,
        });
        continue;
      }
      // Terminal invoke failure — the bridged adapter already emitted its
      // own error event before throwing, so don't re-emit from the outer
      // caller.
      return { kind: 'invoke-failure', error: err };
    }
  }

  // All candidates exhausted (last one threw and wasn't eligible-or-was-last
  // — already returned above). This branch is theoretically unreachable
  // given the loop's exit conditions, but keep it as a defensive guard.
  return lastWasConstruction
    ? { kind: 'construction-failure', error: lastError }
    : { kind: 'invoke-failure', error: lastError };
}

/**
 * Build the candidate list for an agent.
 *
 * Selection order:
 *   1. Pre-built adapter (deps.adapters[agent.id]) — executor-side path
 *      from harness-pipeline. Single non-fallback candidate.
 *   2. Resolver path with `resolveAllBindings`: enumerate every
 *      satisfiable binding for the accept-list. Multiple candidates,
 *      all fallback-eligible. Empty result throws (parity with
 *      `resolveBinding`'s BindingResolutionError behavior).
 *   3. Resolver path WITHOUT `resolveAllBindings`: legacy single-shot
 *      via `resolveBinding`. Single non-fallback candidate.
 *   4. Legacy adapter-id factory.
 *
 * Throws are surfaced to the caller, which treats them as
 * construction-failures.
 */
async function buildCandidates(
  agent: RegisteredAgent,
  deps: RunJobDeps,
  factory: AdapterFactory
): Promise<AgentCandidate[]> {
  // Path 1: pre-built (highest priority — executor pre-resolved at boot
  // and the auth boundary is sharp; we never re-resolve).
  if (deps.adapters) {
    const prebuilt = deps.adapters.get(agent.id);
    if (prebuilt) {
      return [{
        label: `prebuilt:${agent.id}`,
        fallbackEligible: false,
        build: async () => prebuilt,
      }];
    }
    // fall-through: agent absent from the map — executors can pre-build
    // only some agents and let others go through resolver/factory.
  }

  // Path 2 + 3: resolver path
  if (deps.resolver && agent.accepts && agent.accepts.length > 0) {
    const accepts = agent.accepts;
    if (deps.resolver.resolveAllBindings) {
      const bindings = await deps.resolver.resolveAllBindings(accepts);
      if (bindings.length === 0) {
        // Parity with single-shot `resolveBinding`: no satisfiable entry
        // is a hard failure, not an empty success. Throw so the outer
        // caller treats it as construction failure.
        throw new Error(
          `No satisfiable binding for accepts=[${accepts.join(', ')}]`
        );
      }
      const ctor = deps.bindingToAdapterFn ?? bindingToAdapter;
      return bindings.map((binding) => ({
        label: bindingLabel(binding),
        fallbackEligible: bindings.length > 1,
        build: async () => ctor(binding, {
          broker: deps.broker,
          localEndpoint: deps.localEndpoint,
        }),
      }));
    }
    // Path 3: single-shot resolver (no resolveAllBindings).
    return [{
      label: 'resolver',
      fallbackEligible: false,
      build: async () => {
        const binding = await deps.resolver!.resolveBinding(accepts);
        const ctor = deps.bindingToAdapterFn ?? bindingToAdapter;
        return ctor(binding, {
          broker: deps.broker,
          localEndpoint: deps.localEndpoint,
        });
      },
    }];
  }

  // Path 4: legacy adapter-id factory.
  return [{
    label: `factory:${agent.adapter}`,
    fallbackEligible: false,
    build: async () => factory(agent.adapter, deps.broker, agent.config),
  }];
}

function bindingLabel(b: ResolvedBinding): string {
  const prefix = b.tool !== undefined ? `${b.tool}:` : '';
  return `${prefix}${b.provider.id}:${b.model.id}`;
}

function failAgent(
  jobId: string,
  agent: RegisteredAgent,
  job: JobRecord,
  deps: RunJobDeps,
  message: string
): void {
  agent.status = 'failed';
  job.status = 'failed';
  deps.onStatusChange?.(jobId, agent.id, 'failed');
  deps.onStatusChange?.(jobId, null, 'failed');
  deps.bus.publish(jobId, agent.id, {
    kind: 'error',
    ts: new Date().toISOString(),
    message,
  });
}

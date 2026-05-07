import {
  AdapterError,
  type AgentAdapter,
  type BindingToAdapterOptions,
  bindingToAdapter,
  ClaudeSdkAdapter,
  OpenCodeCliAdapter,
  type OpenCodeCliAdapterOptions,
} from '@ecruz165/agent-adapter';
import type { BindingResolver, CredentialBroker, ResolvedBinding } from '@ecruz165/agent-auth';
import { Command } from '@langchain/langgraph';
import type { AdapterId } from './catalog.ts';
import {
  type ApprovalRequest,
  type ApprovalResume,
  compileFlow,
  linearFlowFromAgents,
  type NodeExecutor,
  type SuspendRequest,
} from './flow-graph.ts';
import type { JobRecord, RegisteredAgent } from './job.ts';
import { bridgeAdapter, type JobBus } from './job-bus.ts';

/** Compiled-graph handle cached per-job for resume. Structural so this
 *  module doesn't pin a specific LangGraph type. Exported so callers
 *  (harness-server, tests) can declare their `graphs` Map without
 *  having to mirror the shape inline. */
export interface CompiledFlowGraph {
  invoke(input: unknown, config?: unknown): Promise<Record<string, unknown>>;
}

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
  config?: Record<string, unknown>,
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
   * Used by `@ecruz165/harness-pipeline` (the per-job container runtime),
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
   * to `bindingToAdapter` from `@ecruz165/agent-adapter`. Tests inject this
   * to substitute mock adapters per ResolvedBinding without spawning real
   * SDK clients — important for slice 13c fallback tests, where each
   * candidate must produce a controllable success/failure.
   */
  bindingToAdapterFn?: (binding: ResolvedBinding, options: BindingToAdapterOptions) => AgentAdapter;
  /** Hook for tests / future telemetry. Fires on every status transition. */
  onStatusChange?: (jobId: string, agentId: string | null, status: string) => void;
  /**
   * Per-job compiled-graph cache. When provided, runJob stores the
   * compiled graph keyed by jobId on flows that may pause (Approval or
   * Suspend tags). resumeJob fetches from this map. Caller (typically
   * harness-server) holds a long-lived Map; entries are deleted on
   * job completion or failure.
   *
   * Optional — when absent, paused jobs cannot resume (the next call
   * to resumeJob will throw). In-process demos that don't exercise
   * Approval/Suspend safely omit it.
   */
  graphs?: Map<string, CompiledFlowGraph>;
  /**
   * Hook fired when the graph pauses at an Approval interrupt. Receives
   * the ApprovalRequest payload — assignee role, content under review,
   * etc. Caller is responsible for surfacing this to a reviewer (TUI
   * notification, web UI, Slack, …) and eventually calling resumeJob
   * with the decision.
   */
  onAwaitingApproval?: (jobId: string, request: ApprovalRequest) => void;
  /**
   * Hook fired when the graph pauses at a Suspend interrupt. Receives
   * the SuspendRequest with the suspend trigger (timer or event).
   * Caller schedules the wake-up — setTimeout/cron for timer triggers,
   * event-bus subscription for event triggers — and calls resumeJob
   * with any value (suspend has no meaningful resume payload).
   */
  onSuspend?: (jobId: string, request: SuspendRequest) => void;
}

/**
 * Phase 4 graph-based orchestrator.
 *
 * runJob owns the JobRecord side-effects (status fields, bus events,
 * onStatusChange hook order) and delegates topology to a compiled
 * LangGraph StateGraph (see flow-graph.ts). Per-step-kind logic lives in
 * executor closures built below; the graph compiler routes between them
 * per the FlowDef's edges + tags.
 *
 * Backwards compat: legacy callers pass a JobRecord with a flat agents
 * list and no `flow` field. runJob synthesizes a linear FlowDef from
 * `job.agents` for that case (linearFlowFromAgents from flow-graph.ts),
 * preserving the historical sequential-walk behavior — including the
 * coordinator-skip semantic and the slice 13c per-agent fallback chain
 * inside each agent executor.
 *
 * Failure semantics: fail-fast unchanged. The first agent to throw
 * (without an `error` edge to catch it) terminates the graph; the agent
 * executor sets agent.status='failed' + job.status='failed' before the
 * router throws, so by the time the throw reaches runJob the side-effects
 * are already applied.
 *
 * NOT yet in scope (follow-up commits):
 *   - Tag semantics (Approval interrupt + resume; Suspend checkpoint;
 *     Loop iteration). Tag wrappers in flow-graph.ts are stubs today.
 *   - tool/script/transform/gate/subflow step kinds (executors throw
 *     'not yet implemented').
 *   - Real expression-language sandbox for `js` predicates (jsonpath +
 *     literal work today).
 */
export async function runJob(jobId: string, deps: RunJobDeps): Promise<void> {
  const job = deps.jobs.get(jobId);
  if (!job) return;

  const factory = deps.adapterFactory ?? defaultAdapterFactory;
  job.status = 'running';
  deps.onStatusChange?.(jobId, null, 'running');

  // Use the catalog-attached flow if present; else synthesize a linear
  // flow from the registered agents list (legacy JobRecord shape).
  const flow = job.flow ?? linearFlowFromAgents(`__legacy_${jobId}`, job.agents);

  // Build per-node executors. Only kind:'agent' nodes run real work in
  // this slice; other kinds use the compiler's defaultExecutor (success
  // no-op) — except tool/script/transform/gate/subflow which intentionally
  // throw via the explicit executor below so misuse is loud, not silent.
  const executors = new Map<string, NodeExecutor>();
  for (const node of flow.nodes) {
    if (node.kind === 'agent') {
      executors.set(node.id, makeAgentExecutor(node.id, deps, factory, job, jobId));
    } else if (
      node.kind === 'tool' ||
      node.kind === 'script' ||
      node.kind === 'transform' ||
      node.kind === 'subflow'
    ) {
      // Throw loudly — these step kinds are typed in the catalog but the
      // executor for them is a follow-up. Better to fail fast than to
      // silently no-op and let the graph terminate with phantom success.
      // gate is intentionally NOT in this list: flow-graph's
      // builtinExecutor handles it natively (assertion evaluator).
      const kind = node.kind;
      const id = node.id;
      executors.set(id, async () => {
        throw new Error(`step kind "${kind}" (node "${id}") not yet implemented`);
      });
    }
    // trigger nodes use defaultExecutor (success) — initial state already
    // carries job.input as `output`.
  }

  const graph = compileFlow({ flow, executors }) as CompiledFlowGraph;

  // Cache the compiled graph for resume. Even flows without Approval /
  // Suspend tags benefit minimally — the cache is only consulted by
  // resumeJob, and runJob unconditionally clears it on terminal states.
  deps.graphs?.set(jobId, graph);

  // thread_id ties the graph invocation to its checkpointer entry; same
  // thread_id on resume picks up the same paused state.
  const config = { configurable: { thread_id: jobId } };
  const initial = freshFlowState(jobId, job.input ?? '');

  let result: Record<string, unknown>;
  try {
    result = await graph.invoke(initial, config);
  } catch {
    if (job.status !== 'failed' && job.status !== 'cancelled') {
      job.status = 'failed';
      deps.onStatusChange?.(jobId, null, 'failed');
    }
    deps.graphs?.delete(jobId);
    return;
  }

  finalizeOrPause(jobId, job, result, deps);
}

/**
 * Resume a paused (awaiting-approval or suspended) job by feeding the
 * Command({resume}) value into the cached compiled graph. Invariants:
 *   - The graph instance must exist in deps.graphs (set by runJob).
 *   - The thread_id is the jobId, same as the original invocation, so
 *     the checkpointer rehydrates the right paused state.
 *
 * After resume, the graph either runs to completion (job → completed),
 * pauses again at another interrupt (job → awaiting-approval/suspended),
 * or fails (job → failed).
 *
 * Throws if no cached graph exists for the jobId — callers should treat
 * that as a programming error (resume on a job that never paused, or on
 * a job whose graph was already removed by a prior resumeJob).
 */
export async function resumeJob(
  jobId: string,
  resumeValue: ApprovalResume | unknown,
  deps: RunJobDeps,
): Promise<void> {
  const job = deps.jobs.get(jobId);
  if (!job) return;

  const graph = deps.graphs?.get(jobId);
  if (!graph) {
    throw new Error(
      `resumeJob: no cached graph for jobId "${jobId}" — runJob may not have run yet, or the graph was already cleared.`,
    );
  }

  job.status = 'running';
  deps.onStatusChange?.(jobId, null, 'running');

  const config = { configurable: { thread_id: jobId } };

  let result: Record<string, unknown>;
  try {
    result = await graph.invoke(new Command({ resume: resumeValue }), config);
  } catch {
    if (job.status !== 'failed' && job.status !== 'cancelled') {
      job.status = 'failed';
      deps.onStatusChange?.(jobId, null, 'failed');
    }
    deps.graphs?.delete(jobId);
    return;
  }

  finalizeOrPause(jobId, job, result, deps);
}

/**
 * Compose an effective systemPrompt by appending operator steering
 * onto the agent's baseline. Empty steering returns the baseline
 * verbatim (zero overhead for the steady-state, no-steering case).
 *
 * Format: baseline + a clearly-labeled `[OPERATOR STEERING]` block so
 * the LLM can recognize the addition as out-of-band guidance vs its
 * baseline role description. Steering entries are joined with `\n— `
 * to give the LLM clean delineation between operator-pushed messages.
 *
 * Exported so tests can pin the format and so future skill-based
 * read paths can compose the same way.
 */
export function composeSystemPromptWithSteering(
  baseline: string | undefined,
  steering: readonly string[],
): string | undefined {
  if (steering.length === 0) return baseline;
  const block = `[OPERATOR STEERING]\n— ${steering.join('\n— ')}`;
  if (!baseline) return block;
  return `${baseline}\n\n${block}`;
}

/**
 * Push a steering entry into the live state of a paused or in-flight
 * job. Writes via the LangGraph checkpointer (graph.updateState) so the
 * value lands on the same thread_id the runJob/resumeJob path uses.
 *
 * Effect timing:
 *   - Paused job: applied at the next resume (the resumed node sees
 *     state.steering with the new entry).
 *   - Running job: written to the checkpointer for future ticks; the
 *     currently-executing node won't see it until its NEXT invocation.
 *     LangGraph doesn't expose mid-execution state mutation visibility.
 *
 * Throws if no cached graph exists for the jobId — callers should
 * either ensure runJob has fired first, or fall back to a queued-write
 * pattern (out of scope here).
 */
export async function steerJob(jobId: string, text: string, deps: RunJobDeps): Promise<void> {
  const graph = deps.graphs?.get(jobId);
  if (!graph) {
    throw new Error(
      `steerJob: no cached graph for jobId "${jobId}" — runJob must be in flight or paused.`,
    );
  }
  const config = { configurable: { thread_id: jobId } };
  await callUpdateState(graph, config, { steering: [text] });
}

/**
 * Mark a job for cooperative cancellation. Writes
 * `cancelRequested: true` (and an optional reason) into the live
 * state via the checkpointer; the agent executor checks this at the
 * top of every node-tick and short-circuits to status='cancelled'
 * when set. Hard cancellation of an in-flight adapter call is NOT
 * supported — that requires per-adapter cancel primitives the
 * adapter layer doesn't yet expose.
 *
 * After this returns, callers should expect job.status to transition
 * to 'cancelled' on the NEXT node-tick boundary, not synchronously.
 */
export async function cancelJob(
  jobId: string,
  reason: string | undefined,
  deps: RunJobDeps,
): Promise<void> {
  const graph = deps.graphs?.get(jobId);
  if (!graph) {
    throw new Error(
      `cancelJob: no cached graph for jobId "${jobId}" — runJob must be in flight or paused.`,
    );
  }
  const config = { configurable: { thread_id: jobId } };
  await callUpdateState(graph, config, {
    cancelRequested: true,
    cancelReason: reason ?? null,
  });
}

/**
 * Read the current steering array for a job. Reads via
 * graph.getState(config); returns an empty array when the graph or
 * state is missing. Used by the GET /v1/jobs/:id/steering route to
 * surface the current value to agents (active-pull pattern via
 * `harness steering check`) and to dispatchers polling for
 * visibility.
 */
export async function getJobSteering(jobId: string, deps: RunJobDeps): Promise<readonly string[]> {
  const graph = deps.graphs?.get(jobId);
  if (!graph) return [];
  const config = { configurable: { thread_id: jobId } };
  const state = await callGetState(graph, config);
  const steering = state?.values?.steering;
  return Array.isArray(steering) ? (steering as string[]) : [];
}

/**
 * Structural call to `graph.updateState(config, partial)`. The
 * CompiledFlowGraph type we cache doesn't include updateState in its
 * minimal contract (we only enforced `invoke`); cast through here so
 * the helper is the single place that asserts the runtime shape.
 */
async function callUpdateState(
  graph: CompiledFlowGraph,
  config: { configurable: { thread_id: string } },
  partial: Record<string, unknown>,
): Promise<void> {
  const g = graph as unknown as {
    updateState: (cfg: typeof config, values: Record<string, unknown>) => Promise<unknown>;
  };
  if (typeof g.updateState !== 'function') {
    throw new Error('compiled graph has no updateState method — checkpointer required');
  }
  await g.updateState(config, partial);
}

async function callGetState(
  graph: CompiledFlowGraph,
  config: { configurable: { thread_id: string } },
): Promise<{ values?: Record<string, unknown> } | null> {
  const g = graph as unknown as {
    getState: (cfg: typeof config) => Promise<{ values?: Record<string, unknown> } | null>;
  };
  if (typeof g.getState !== 'function') return null;
  return g.getState(config);
}

function freshFlowState(jobId: string, input: string) {
  return {
    jobId,
    output: input,
    messages: [],
    attempts: {},
    lastExit: null,
    rejectionPayload: null,
    steering: [],
    cancelRequested: false,
    cancelReason: null,
  };
}

/**
 * Common post-invoke handler for runJob and resumeJob. Inspects the
 * graph result for an `__interrupt__` field (Approval or Suspend
 * interrupts) and updates JobRecord accordingly:
 *
 *   - Approval interrupt → job.status = 'awaiting-approval', fire
 *     onAwaitingApproval, KEEP the cached graph (will be needed for
 *     resume).
 *   - Suspend interrupt → job.status = 'suspended', fire onSuspend,
 *     KEEP the cached graph.
 *   - No interrupt + job not failed → terminal success: job.status =
 *     'completed', clear the cached graph (graph instance is no longer
 *     needed; the JobRecord retains the final state).
 *   - No interrupt + job already failed → terminal failure (agent
 *     executor already set this); clear the cached graph.
 */
function finalizeOrPause(
  jobId: string,
  job: JobRecord,
  result: Record<string, unknown>,
  deps: RunJobDeps,
): void {
  const interrupts = extractInterrupts(result);
  if (interrupts.length > 0) {
    const first = interrupts[0];
    if (first?.kind === 'approval') {
      job.status = 'awaiting-approval';
      deps.onStatusChange?.(jobId, null, 'awaiting-approval');
      deps.onAwaitingApproval?.(jobId, first);
      return;
    }
    if (first?.kind === 'suspend') {
      job.status = 'suspended';
      deps.onStatusChange?.(jobId, null, 'suspended');
      deps.onSuspend?.(jobId, first);
      return;
    }
    // Unknown interrupt kind — treat as awaiting-approval-ish pause.
    // Defensive: don't lose the cached graph.
    job.status = 'awaiting-approval';
    deps.onStatusChange?.(jobId, null, 'awaiting-approval');
    return;
  }

  // No interrupt — terminal state. Preserve cancelled / failed; only
  // promote to 'completed' from 'running' (the normal happy path).
  if (job.status !== 'failed' && job.status !== 'cancelled') {
    job.status = 'completed';
    deps.onStatusChange?.(jobId, null, 'completed');
  }
  deps.graphs?.delete(jobId);
}

function extractInterrupts(
  result: Record<string, unknown>,
): Array<ApprovalRequest | SuspendRequest> {
  const raw = result.__interrupt__;
  if (!Array.isArray(raw)) return [];
  const out: Array<ApprovalRequest | SuspendRequest> = [];
  for (const entry of raw) {
    if (entry && typeof entry === 'object' && 'value' in entry) {
      const value = (entry as { value: unknown }).value;
      if (
        value &&
        typeof value === 'object' &&
        'kind' in value &&
        ((value as { kind: unknown }).kind === 'approval' ||
          (value as { kind: unknown }).kind === 'suspend')
      ) {
        out.push(value as ApprovalRequest | SuspendRequest);
      }
    }
  }
  return out;
}

/**
 * Build the per-node executor for a kind:'agent' TaskStep. Looks up the
 * RegisteredAgent on the JobRecord by id (registration walks the FlowDef
 * via walkAgents and creates a RegisteredAgent per node, so the ids
 * align). The executor:
 *
 *   1. Skips coordinator / checkout-coordinator (returns success exit
 *      without running any adapter — preserves the historical hardcoded-
 *      skip semantic).
 *   2. Marks the agent running + fires onStatusChange.
 *   3. Runs the existing buildCandidates → runCandidates pipeline, which
 *      handles slice 13c multi-binding fallback inside the agent.
 *   4. On success: marks agent completed, returns { output, lastExit }.
 *   5. On failure: marks agent + job failed, fires onStatusChange in the
 *      historical order (agent then job), returns an error exit so the
 *      router can dispatch to an `error` edge if present (else throw).
 *
 * Construction-failure: the synthetic "adapter construction failed" bus
 * event (parity with pre-Phase-4 behavior) is published here for both
 * eager-buildCandidates throws and runCandidates' construction-failure
 * outcome.
 */
function makeAgentExecutor(
  agentId: string,
  deps: RunJobDeps,
  factory: AdapterFactory,
  job: JobRecord,
  jobId: string,
): NodeExecutor {
  return async (state) => {
    const agent = job.agents.find((a) => a.id === agentId);
    if (!agent || agent.id === 'coordinator' || agent.id === 'checkout-coordinator') {
      return { lastExit: { nodeId: agentId, kind: 'success' } };
    }

    // Cooperative cancellation: check at the boundary BEFORE any work.
    // Mark the agent + job 'cancelled' as a side-effect (mirrors the
    // failure-side pattern) and return an error exit. The router will
    // throw (no error edge handles 'Cancelled' specially), runJob's
    // outer catch detects job.status === 'cancelled' and skips the
    // defensive 'failed' transition.
    if (state.cancelRequested) {
      agent.status = 'cancelled';
      job.status = 'cancelled';
      deps.onStatusChange?.(jobId, agent.id, 'cancelled');
      deps.onStatusChange?.(jobId, null, 'cancelled');
      return {
        lastExit: {
          nodeId: agentId,
          kind: 'error',
          errorName: 'Cancelled',
          errorMessage: state.cancelReason ?? 'cancelled by operator',
        },
      };
    }

    agent.status = 'running';
    deps.onStatusChange?.(jobId, agent.id, 'running');

    let candidates: AgentCandidate[];
    try {
      candidates = await buildCandidates(agent, deps, factory);
    } catch (err) {
      failAgent(jobId, agent, job, deps, `adapter construction failed: ${(err as Error).message}`);
      return {
        lastExit: {
          nodeId: agentId,
          kind: 'error',
          errorName: 'ConstructionFailure',
          errorMessage: (err as Error).message,
        },
      };
    }

    // Compose the effective systemPrompt: agent.systemPrompt + any
    // accumulated operator steering. Steering is prepended as a
    // separately-marked block so the agent can recognize it as
    // out-of-band guidance vs its baseline role definition.
    const effectiveSystemPrompt = composeSystemPromptWithSteering(
      agent.systemPrompt,
      state.steering,
    );

    const outcome = await runCandidates(
      candidates,
      agent,
      state.output,
      deps,
      jobId,
      effectiveSystemPrompt,
    );

    if (outcome.kind === 'success') {
      agent.status = 'completed';
      deps.onStatusChange?.(jobId, agent.id, 'completed');
      return {
        output: outcome.result,
        lastExit: { nodeId: agentId, kind: 'success' },
      };
    }

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
    return {
      lastExit: {
        nodeId: agentId,
        kind: 'error',
        errorName: outcome.error instanceof Error ? outcome.error.name : 'Error',
        errorMessage:
          outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      },
    };
  };
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
  jobId: string,
  systemPrompt: string | undefined = agent.systemPrompt,
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
        system: systemPrompt,
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
  factory: AdapterFactory,
): Promise<AgentCandidate[]> {
  // Path 1: pre-built (highest priority — executor pre-resolved at boot
  // and the auth boundary is sharp; we never re-resolve).
  if (deps.adapters) {
    const prebuilt = deps.adapters.get(agent.id);
    if (prebuilt) {
      return [
        {
          label: `prebuilt:${agent.id}`,
          fallbackEligible: false,
          build: async () => prebuilt,
        },
      ];
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
        throw new Error(`No satisfiable binding for accepts=[${accepts.join(', ')}]`);
      }
      const ctor = deps.bindingToAdapterFn ?? bindingToAdapter;
      return bindings.map((binding) => ({
        label: bindingLabel(binding),
        fallbackEligible: bindings.length > 1,
        build: async () =>
          ctor(binding, {
            broker: deps.broker,
            localEndpoint: deps.localEndpoint,
          }),
      }));
    }
    // Path 3: single-shot resolver (no resolveAllBindings).
    return [
      {
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
      },
    ];
  }

  // Path 4: legacy adapter-id factory.
  return [
    {
      label: `factory:${agent.adapter}`,
      fallbackEligible: false,
      build: async () => factory(agent.adapter, deps.broker, agent.config),
    },
  ];
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
  message: string,
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

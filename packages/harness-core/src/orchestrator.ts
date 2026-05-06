import {
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
} from '@agentx/agent-auth-lib';
import type { AdapterId } from './catalog.ts';
import { bridgeAdapter, type JobBus } from './job-bus.ts';
import type { JobRecord, RegisteredAgent } from './job.ts';

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

    let adapter: AgentAdapter;
    try {
      adapter = await constructAgentAdapter(agent, deps, factory);
    } catch (err) {
      agent.status = 'failed';
      job.status = 'failed';
      deps.onStatusChange?.(jobId, agent.id, 'failed');
      deps.onStatusChange?.(jobId, null, 'failed');
      deps.bus.publish(jobId, agent.id, {
        kind: 'error',
        ts: new Date().toISOString(),
        message: `adapter construction failed: ${(err as Error).message}`,
      });
      return;
    }

    const detach = bridgeAdapter(deps.bus, jobId, agent.id, adapter.events);
    try {
      const result = await adapter.invoke({
        system: agent.systemPrompt,
        user: priorOutput,
      });
      priorOutput = result;
      agent.status = 'completed';
      deps.onStatusChange?.(jobId, agent.id, 'completed');
    } catch {
      agent.status = 'failed';
      job.status = 'failed';
      deps.onStatusChange?.(jobId, agent.id, 'failed');
      deps.onStatusChange?.(jobId, null, 'failed');
      detach();
      return;
    }
    detach();
  }

  job.status = 'completed';
  deps.onStatusChange?.(jobId, null, 'completed');
}

/**
 * Picks the adapter for a single agent. When the agent declares a non-empty
 * `accepts` list AND the deps include a resolver, route through the new
 * binding-resolution path: resolver → ResolvedBinding → bindingToAdapter.
 * Otherwise fall through to the legacy adapter-id factory.
 *
 * Failures are intentionally NOT caught here — they propagate to the caller
 * (runJob), which already has the agent/job state-transition + error-event
 * publishing logic centralized.
 */
async function constructAgentAdapter(
  agent: RegisteredAgent,
  deps: RunJobDeps,
  factory: AdapterFactory
): Promise<AgentAdapter> {
  if (deps.resolver && agent.accepts && agent.accepts.length > 0) {
    const binding = await deps.resolver.resolveBinding(agent.accepts);
    return bindingToAdapter(binding, {
      broker: deps.broker,
      localEndpoint: deps.localEndpoint,
    });
  }
  return factory(agent.adapter, deps.broker, agent.config);
}

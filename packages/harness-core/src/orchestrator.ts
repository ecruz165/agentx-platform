import {
  ClaudeSdkAdapter,
  OpenCodeCliAdapter,
  type AgentAdapter,
} from '@agentx/agent-adapter';
import type { CredentialBroker } from '@agentx/auth-lib';
import type { AdapterId } from './catalog.ts';
import { bridgeAdapter, type JobBus } from './job-bus.ts';
import type { JobRecord } from './job.ts';

/**
 * Constructs the concrete adapter for an agent's `adapter` id, with the
 * credential broker injected. Pulled out into a factory so tests can swap
 * in mock adapters without monkeypatching the SDK.
 */
export type AdapterFactory = (
  adapterId: AdapterId,
  broker: CredentialBroker
) => AgentAdapter;

export const defaultAdapterFactory: AdapterFactory = (id, broker) => {
  if (id === 'claude-sdk') return new ClaudeSdkAdapter({ broker });
  if (id === 'opencode-cli') return new OpenCodeCliAdapter({ broker });
  throw new Error(`unknown adapter id: ${id}`);
};

export interface RunJobDeps {
  jobs: Map<string, JobRecord>;
  bus: JobBus;
  broker: CredentialBroker;
  adapterFactory?: AdapterFactory;
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
    if (agent.id === 'coordinator') continue;

    agent.status = 'running';
    deps.onStatusChange?.(jobId, agent.id, 'running');

    let adapter: AgentAdapter;
    try {
      adapter = factory(agent.adapter, deps.broker);
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

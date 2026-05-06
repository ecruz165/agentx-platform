/**
 * TokenAccumulator — subscribes to the JobBus, turns adapter-emitted
 * `TokenUsage` (slice 13a) into per-agent + per-job running totals on
 * the JobRecord.
 *
 * Architecture (slice 13d): adapters already emit `usage` on every
 * `response` event. The accumulator's job is to fan those emissions
 * into shape that:
 *   - serializes through GET /v1/jobs and GET /v1/jobs/:id (mutates
 *     the JobRecord directly — no new endpoint needed)
 *   - is readable by any client (CLI TUI today, hosted console later)
 *   - preserves per-call shape (`tokenHistory`) for cost analysis,
 *     not just cumulative totals
 *
 * Wiring constraint: `JobBus.publish` drops events when no subscriber
 * is attached for that jobId (job-bus.ts:25-27). The accumulator
 * MUST be attached BEFORE the first `response` event is published —
 * harness-server attaches at job-create time, before runJob fires.
 *
 * Lifetime: attach on job-create, detach on job-complete. Detaching
 * stops the subscription but leaves accumulated state on the
 * JobRecord — clients can still query final totals via the API.
 *
 * Sum semantics caveat: `out` adds cleanly. `in` does NOT — providers
 * report prompt_tokens as the FULL context sent THIS call, which on
 * multi-turn agents includes prior turns. Renderers should treat the
 * cumulative `in` as "billed input" not "context size."
 */

import type { AgentTokens, JobRecord } from './job.ts';
import type { Envelope, JobBus } from './job-bus.ts';

export class TokenAccumulator {
  private readonly unsubs = new Map<string, () => void>();

  constructor(private readonly jobs: Map<string, JobRecord>) {}

  /**
   * Subscribe to a job's events and start accumulating. Idempotent —
   * re-attaching to the same jobId is a no-op (returns the existing
   * unsubscriber). Safe to call before the JobRecord has agents
   * registered; events for unknown agents are silently dropped.
   */
  attach(bus: JobBus, jobId: string): () => void {
    const existing = this.unsubs.get(jobId);
    if (existing) return existing;

    const unsub = bus.subscribe(jobId, (env) => this.handle(env));
    this.unsubs.set(jobId, unsub);
    return unsub;
  }

  /**
   * Stop accumulating for a job. The JobRecord retains its
   * `tokens`/`tokenHistory` fields — detaching only ends the
   * subscription, not the state. Idempotent.
   */
  detach(jobId: string): void {
    const unsub = this.unsubs.get(jobId);
    if (!unsub) return;
    unsub();
    this.unsubs.delete(jobId);
  }

  /** Test helper — list of currently-attached jobIds. */
  attachedJobIds(): readonly string[] {
    return [...this.unsubs.keys()];
  }

  private handle(env: Envelope): void {
    if (env.event.kind !== 'response') return;
    const usage = env.event.usage;
    if (!usage) return;

    const job = this.jobs.get(env.jobId);
    if (!job) return;

    const agent = job.agents.find((a) => a.id === env.agentId);
    if (!agent) return;

    const entry: AgentTokens = {
      in: usage.promptTokens ?? 0,
      out: usage.completionTokens ?? 0,
    };

    // Skip no-signal entries — providers occasionally report a usage
    // block where every field is missing/undefined. Pushing those
    // would clutter the history without adding information.
    if (entry.in === 0 && entry.out === 0) return;

    // Per-agent: append to history + bump running sum.
    if (!agent.tokenHistory) agent.tokenHistory = [];
    agent.tokenHistory.push(entry);
    agent.tokens = sum(agent.tokens, entry);

    // Per-job: bump running sum.
    job.tokens = sum(job.tokens, entry);
  }
}

function sum(prev: AgentTokens | undefined, inc: AgentTokens): AgentTokens {
  if (!prev) return { in: inc.in, out: inc.out };
  return { in: prev.in + inc.in, out: prev.out + inc.out };
}

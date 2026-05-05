import type { AdapterEvent, AdapterEventSource } from '@agentx/agent-adapter';

/**
 * Job-scoped envelope wrapping an adapter event with the {jobId, agentId} that
 * produced it. External consumers (TUI, web UI, future audit pipeline) see this
 * shape — they never talk to adapters directly.
 */
export interface Envelope {
  jobId: string;
  agentId: string;
  event: AdapterEvent;
}

/**
 * In-memory pub/sub multiplexer. The harness-server owns one of these and
 * bridges every spawned adapter's events into it (see `bridgeAdapter`).
 * Subscribers attach by jobId; events from other jobs never reach them.
 *
 * Throw isolation matches the AdapterEventBus contract: one consumer's failure
 * cannot break delivery to others or propagate back to the producing adapter.
 */
export class JobBus {
  private readonly handlers = new Map<string, Set<(env: Envelope) => void>>();

  publish(jobId: string, agentId: string, event: AdapterEvent): void {
    const set = this.handlers.get(jobId);
    if (!set) return;
    const envelope: Envelope = { jobId, agentId, event };
    for (const handler of set) {
      try {
        handler(envelope);
      } catch {
        // Isolated; producer (and other consumers) keep going.
      }
    }
  }

  subscribe(jobId: string, handler: (env: Envelope) => void): () => void {
    let set = this.handlers.get(jobId);
    if (!set) {
      set = new Set();
      this.handlers.set(jobId, set);
    }
    set.add(handler);
    return () => {
      const current = this.handlers.get(jobId);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.handlers.delete(jobId);
    };
  }

  subscriberCount(jobId: string): number {
    return this.handlers.get(jobId)?.size ?? 0;
  }
}

/**
 * Subscribe to a single adapter's event source and re-publish each event onto
 * the job bus tagged with `{jobId, agentId}`. Returns an unsubscribe function
 * that detaches the bridge.
 *
 * Call sites: when the orchestrator (Phase 4+) spawns an agent, it constructs
 * the adapter and immediately bridges its events into the job-scoped bus, so
 * SSE consumers and any future archiver see a single ordered stream per job.
 */
export function bridgeAdapter(
  bus: JobBus,
  jobId: string,
  agentId: string,
  source: AdapterEventSource
): () => void {
  return source.subscribe((event) => {
    bus.publish(jobId, agentId, event);
  });
}

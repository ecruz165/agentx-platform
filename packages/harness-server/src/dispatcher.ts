/**
 * In-process runJob dispatcher — concurrency control + FIFO queue.
 *
 * The harness-server fires runJob via queueMicrotask after responding to
 * POST /v1/jobs. Without bounded concurrency, 100 concurrent submissions
 * spawn 100 parallel runJob promises competing for adapter slots and
 * LLM rate limits. This module gates entry: at most `capacity`
 * concurrent runJobs; submissions beyond that wait in a FIFO queue;
 * submissions when the queue is full are rejected at the HTTP layer
 * (503 Queue Full) so callers can retry-with-backoff or adjust load.
 *
 * State lives on ServerCtx (inFlight Set, queue array, capacity number).
 * This module exposes pure-ish helpers that mutate that state — easier
 * than a class given the small surface area, and matches the existing
 * ServerCtx pattern. Graduate to a class when policy grows.
 *
 * Concerns NOT here:
 *   - The container runJob path. Each container is its own concurrency
 *     boundary; the dispatcher only governs the in-process path.
 *   - Resume / steer / cancel. Those operate on already-running jobs;
 *     their concurrency is owned by the original runJob's dispatcher
 *     slot (a paused job still occupies a slot until terminal).
 */

interface DispatcherState {
  inFlight: Set<string>;
  queue: QueuedSubmission[];
  capacity: number;
}

interface QueuedSubmission {
  jobId: string;
  enqueuedAt: number;
  fire: () => void;
}

/** Backpressure threshold — queue depth at which submit returns 503. */
const QUEUE_BACKPRESSURE_MULTIPLIER = 2;

/**
 * Decision for a new submission. The handler uses this to either send
 * 200 (accepted) and proceed, or 503 (rejected). Decoupled from HTTP
 * so the helper stays testable.
 */
export type DispatchDecision =
  | { kind: 'fire-immediate' }
  | { kind: 'enqueue' }
  | { kind: 'reject'; reason: string };

/**
 * Decide whether a new submission can be accepted. Doesn't mutate
 * state — caller checks the decision and calls `accept()` or sends
 * 503 accordingly.
 */
export function evaluateSubmission(state: DispatcherState): DispatchDecision {
  if (state.inFlight.size < state.capacity) {
    return { kind: 'fire-immediate' };
  }
  const overflowAt = state.capacity * QUEUE_BACKPRESSURE_MULTIPLIER;
  if (state.inFlight.size + state.queue.length >= overflowAt) {
    return {
      kind: 'reject',
      reason: `queue full — ${state.inFlight.size} in-flight, ${state.queue.length} queued, max ${overflowAt}`,
    };
  }
  return { kind: 'enqueue' };
}

/**
 * Mark a job as in-flight and call its fire closure on the next tick.
 * Caller validated capacity via evaluateSubmission first.
 */
export function fireImmediate(state: DispatcherState, jobId: string, fire: () => void): void {
  state.inFlight.add(jobId);
  queueMicrotask(fire);
}

/** Add a job to the FIFO queue. Caller validated capacity first. */
export function enqueue(state: DispatcherState, jobId: string, fire: () => void): void {
  state.queue.push({ jobId, enqueuedAt: Date.now(), fire });
}

/**
 * Hook to call when a job reaches a terminal status (completed, failed,
 * cancelled). Removes the jobId from inFlight and pulls the next queued
 * submission, if any, into the freed slot. Idempotent — calling twice
 * with the same jobId is a no-op the second time.
 *
 * Note: 'awaiting-approval' and 'suspended' are NOT terminal — paused
 * jobs continue to occupy their dispatcher slot until they actually
 * complete or fail. This is intentional: a paused job is still "in
 * flight" from the dispatcher's perspective (its compiled graph + state
 * is held in memory waiting for resume).
 */
export function onJobTerminal(state: DispatcherState, jobId: string): void {
  if (!state.inFlight.delete(jobId)) return;
  // Pull next queued submission into the freed slot.
  const next = state.queue.shift();
  if (next) {
    state.inFlight.add(next.jobId);
    queueMicrotask(next.fire);
  }
}

/**
 * Status snapshot for the GET /v1/dispatcher/status endpoint. Returns
 * a plain object suitable for JSON serialization.
 */
export function statusSnapshot(state: DispatcherState): {
  capacity: number;
  inFlight: string[];
  queued: Array<{ jobId: string; enqueuedAt: number; waitingMs: number }>;
} {
  const now = Date.now();
  return {
    capacity: state.capacity,
    inFlight: [...state.inFlight],
    queued: state.queue.map((q) => ({
      jobId: q.jobId,
      enqueuedAt: q.enqueuedAt,
      waitingMs: now - q.enqueuedAt,
    })),
  };
}

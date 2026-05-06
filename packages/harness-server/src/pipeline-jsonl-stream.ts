/**
 * Shared JSONL-stream consumer for harness-pipeline executor processes.
 *
 * Both `runPipelineSubprocess` (tsx-based, slice 9d-1) and
 * `runPipelineInContainer` (devcontainer-exec-based, slice 9d-3) spawn
 * the same harness-pipeline binary and consume its line-delimited JSON
 * envelope stream. The transport differs (local pipe vs Docker exec
 * pipe) but the parsing semantics are identical:
 *
 *   - Each non-empty stdout line is one JSON object
 *   - Either an Envelope `{jobId, agentId, event}` to republish
 *   - OR a JobCompleteSentinel `{kind:'job-complete', jobId, status}`
 *     marking job-level outcome
 *   - Stderr is captured (tail-capped) for diagnostics
 *   - Lines that aren't JSON or don't match either shape are skipped
 *     with a warning to harness-server's stderr (don't poison the bus)
 *
 * Lifting this into a shared module means future spawn shapes (ECS
 * Fargate task w/ CloudWatch log streaming, remote SSH exec, etc.)
 * just need to feed bytes into `consumeJsonlStream` — they don't need
 * to re-implement the framing.
 */

import type { Readable } from 'node:stream';
import type { Envelope, JobBus } from '@agentx/harness-core';

/** Sentinel emitted by harness-pipeline's bin.ts as its final stdout
 *  line — communicates job-level outcome distinct from any envelope. */
export interface JobCompleteSentinel {
  kind: 'job-complete';
  jobId: string;
  status: string;
}

export interface ConsumeStreamResult {
  /** The sentinel observed during the run, if any. Absent when the
   *  executor crashed before emitting one. */
  sentinel: JobCompleteSentinel | undefined;
  /** Stderr tail captured during the run, capped at 4 KiB. */
  stderrTail: string;
}

const STDERR_TAIL_CAP = 4096;

/**
 * Bind to a child process's stdout + stderr streams and republish
 * envelopes onto the parent's JobBus until both streams close.
 *
 * Resolves with the sentinel (if any) and the captured stderr tail.
 * Does NOT manage the child process's exit/close lifecycle — callers
 * await the child's `close` separately and combine with this result.
 *
 * @param expectedJobId - drop envelopes whose jobId doesn't match.
 *   Defensive: a misbehaving executor shouldn't be able to poison
 *   another job's bus.
 */
export function consumeJsonlStream(args: {
  stdout: Readable;
  stderr: Readable;
  bus: JobBus;
  expectedJobId: string;
  onSentinel?: (s: JobCompleteSentinel) => void;
}): Promise<ConsumeStreamResult> {
  return new Promise((resolveP) => {
    let sentinel: JobCompleteSentinel | undefined;
    let stdoutBuf = '';
    let stderrTail = '';
    let stdoutClosed = false;
    let stderrClosed = false;

    const maybeResolve = () => {
      if (stdoutClosed && stderrClosed) {
        resolveP({ sentinel, stderrTail });
      }
    };

    args.stdout.on('data', (chunk: Buffer | string) => {
      stdoutBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      while (true) {
        const idx = stdoutBuf.indexOf('\n');
        if (idx === -1) break;
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line.length === 0) continue;
        const result = processLine(line, args.expectedJobId, args.bus);
        if (result?.kind === 'sentinel') {
          sentinel = result.sentinel;
          args.onSentinel?.(result.sentinel);
        }
      }
    });
    args.stdout.on('end', () => {
      // Final flush: a partial line at end-of-stream is dropped (no
      // \n terminator means we can't be sure it's complete). Real
      // executors always end on a newline.
      stdoutClosed = true;
      maybeResolve();
    });
    args.stdout.on('error', () => {
      stdoutClosed = true;
      maybeResolve();
    });

    args.stderr.on('data', (chunk: Buffer | string) => {
      stderrTail += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (stderrTail.length > STDERR_TAIL_CAP) {
        stderrTail = stderrTail.slice(-STDERR_TAIL_CAP);
      }
    });
    args.stderr.on('end', () => {
      stderrClosed = true;
      maybeResolve();
    });
    args.stderr.on('error', () => {
      stderrClosed = true;
      maybeResolve();
    });
  });
}

type LineResult =
  | { kind: 'sentinel'; sentinel: JobCompleteSentinel }
  | { kind: 'envelope' }
  | undefined;

function processLine(line: string, expectedJobId: string, bus: JobBus): LineResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    process.stderr.write(`harness-pipeline: non-JSON stdout line skipped: ${line.slice(0, 200)}\n`);
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;

  const obj = parsed as Record<string, unknown>;
  if (obj.kind === 'job-complete') {
    return { kind: 'sentinel', sentinel: obj as unknown as JobCompleteSentinel };
  }

  // Envelope shape: {jobId, agentId, event}
  if (
    typeof obj.jobId !== 'string' ||
    typeof obj.agentId !== 'string' ||
    typeof obj.event !== 'object'
  ) {
    process.stderr.write(`harness-pipeline: malformed envelope on stdout: ${line.slice(0, 200)}\n`);
    return undefined;
  }

  if (obj.jobId !== expectedJobId) {
    process.stderr.write(
      `harness-pipeline: dropping envelope with mismatched jobId (got ${String(obj.jobId)}, expected ${expectedJobId})\n`,
    );
    return undefined;
  }

  const env = obj as unknown as Envelope;
  bus.publish(env.jobId, env.agentId, env.event);
  return { kind: 'envelope' };
}

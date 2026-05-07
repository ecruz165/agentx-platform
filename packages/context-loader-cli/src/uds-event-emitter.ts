/**
 * Job-mode event emitter — opens a Unix domain socket and writes
 * IngestionEvents as newline-delimited JSON.
 *
 * Wire format per `prd-context-loader-cli.md` §9:
 *   - One JSON object per line, terminated by \n
 *   - Every object has at least { jobId, ts, kind, ... }
 *   - Heartbeat every 5 seconds of silence: { kind: 'heartbeat', jobId, ts }
 *   - On SIGTERM: { kind: 'cancelled', jobId, ts, reason: 'sigterm' }
 *   - On normal completion: the underlying loader's source-completed event
 *     (already wrapped with jobId/ts) plus a clean socket close.
 *
 * The reader on the other side is harness-server's spawnWorker scaffolding;
 * it parses lines and routes them onto the JobBus.
 */

import { connect, type Socket } from 'node:net';
import type { IngestionEvent } from '@ecruz165/context-loader-core';

const HEARTBEAT_INTERVAL_MS = 5000;

export interface UdsEmitterOptions {
  socketPath: string;
  jobId: string;
  /** Override the clock for tests. */
  now?: () => number;
}

export interface UdsEmitter {
  /** Synchronously enqueue an event onto the socket buffer. Each call
   *  resets the heartbeat timer. */
  emit(event: IngestionEvent): void;
  /** Emit a CLI-only event that's not part of the IngestionEvent union
   *  (heartbeat, cancelled). Same wire format. */
  emitMeta(kind: string, extra?: Record<string, unknown>): void;
  /** Flush any buffered writes and close the socket. */
  close(): Promise<void>;
}

/** Connect to the UDS and start the heartbeat timer. Throws if the socket
 *  is unreachable — that's a fatal misconfiguration the worker should
 *  surface to its parent rather than silently dropping events. */
export async function connectUdsEmitter(opts: UdsEmitterOptions): Promise<UdsEmitter> {
  const now = opts.now ?? (() => Date.now());

  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = connect({ path: opts.socketPath });
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });

  let lastEmitMs = now();
  let closed = false;

  const heartbeat = setInterval(() => {
    if (closed) return;
    if (now() - lastEmitMs >= HEARTBEAT_INTERVAL_MS) {
      writeLine({ kind: 'heartbeat', jobId: opts.jobId, ts: now() });
    }
  }, HEARTBEAT_INTERVAL_MS);
  // Don't keep the event loop alive for the heartbeat alone — when the
  // ingestion finishes, the process should exit cleanly.
  heartbeat.unref();

  function writeLine(payload: object): void {
    if (closed) return;
    socket.write(`${JSON.stringify(payload)}\n`);
    lastEmitMs = now();
  }

  return {
    emit(event) {
      writeLine({ jobId: opts.jobId, ts: now(), ...event });
    },
    emitMeta(kind, extra = {}) {
      writeLine({ jobId: opts.jobId, ts: now(), kind, ...extra });
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      await new Promise<void>((resolve) => {
        socket.end(() => resolve());
      });
    },
  };
}

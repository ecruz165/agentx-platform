import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AdapterEvent } from './events.ts';

/**
 * Redacts credentials from adapter events before any subscriber sees them.
 *
 * Critical-path: this runs inside `AdapterEventBus.emit` on every event, so
 * file writers, terminal renderers, and server-side bridges all receive the
 * redacted form. The MVP-0 verification gate (examples/verify-no-leak.ts)
 * still applies — no `sk-ant-*`, `sk-*`, or `AIza*` pattern may appear in
 * any capture file or terminal pane.
 *
 * TODO(you): implement this body. ~5–10 lines. The decisions that shape it:
 *
 *   1. Patterns. Anthropic: /sk-ant-[A-Za-z0-9_-]{16,}/. OpenAI:
 *      /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/. Google: /AIza[A-Za-z0-9_-]{20,}/.
 *      Where does the registry live — here, or imported from auth-lib?
 *
 *   2. Depth. AdapterEvent payloads are mostly flat (system, user, text), but
 *      `response.raw` is an SDK-specific object that may nest deep. Top-level
 *      string scrubbing is fast; recursive walk into `raw` is safer but
 *      allocates per write.
 *
 *   3. Replacement. "[REDACTED]" preserves the surrounding string structure;
 *      stripping the field entirely shrinks the payload but loses context.
 *
 * Constraint: pure, synchronous, allocation-conscious — fires per event.
 *
 * @see examples/verify-no-leak.ts — the gate this function must pass.
 */
export function redactEvent(event: AdapterEvent): AdapterEvent {
  return event;
}

/**
 * Default subscriber that appends events to a JSONL file. Writes are queued
 * so the bus's synchronous `emit` doesn't block on disk; `drain()` waits for
 * everything to land before the caller exits.
 */
export class FileEventSubscriber {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  readonly handler = (event: AdapterEvent): void => {
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, JSON.stringify(event) + '\n', 'utf8');
    });
  };

  drain(): Promise<void> {
    return this.queue;
  }
}

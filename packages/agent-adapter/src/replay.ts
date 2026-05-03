import { readFile } from 'node:fs/promises';
import type { AdapterEvent, AdapterEventSource } from './events.ts';

/**
 * Replay historical events from a JSONL file to `handler`, then subscribe
 * `handler` to the live `source` so it continues receiving new events.
 *
 * Returns an `unsubscribe` function that detaches the live subscription.
 *
 * Use case: a TUI attaches to a job that's already in flight. The per-agent
 * JSONL file holds the events emitted before the TUI connected; the bus
 * holds the live stream. This helper joins them so `handler` sees a single
 * ordered sequence.
 *
 * Empty or missing files are treated as "no history" — the helper subscribes
 * directly without throwing.
 *
 * TODO(you): gap-handling policy. Today this implementation is read-stop-at-EOF:
 * we read the file once at call time, then subscribe. Events emitted *between*
 * the file read and the subscribe call (typically a few ms) reach neither path
 * and are missed. Three policies to choose from:
 *
 *   1. **Read-stop-at-EOF** (current): simplest; small gap window; OK for
 *      MVP-2 where the producer rarely emits faster than disk flush.
 *   2. **High-water mark**: track byte offset; after first read, re-read from
 *      offset; loop until EOF stays stable for one tick. Closes the gap at the
 *      cost of an extra read.
 *   3. **Subscribe-then-replay-with-dedup**: subscribe first into a buffer,
 *      then read the file, emit historical, then drain buffer using a seq or
 *      ts-based dedup key. Most correct; requires events to carry a monotonic
 *      seq number (we don't have one yet).
 *
 * The right answer depends on whether the producer ever emits faster than the
 * file write completes — pick after Phase 3 (JobBus) lands and we can measure.
 *
 * Constraint: handler must not be invoked concurrently with itself. The current
 * impl is sequential: full replay completes before the live subscription starts.
 */
export async function replayThenSubscribe(
  path: string,
  source: AdapterEventSource,
  handler: (event: AdapterEvent) => void
): Promise<() => void> {
  const historical = await readJsonlEvents(path);
  for (const event of historical) {
    try {
      handler(event);
    } catch {
      // One bad replayed event must not stop the rest, mirroring the bus
      // throw-isolation contract (events.ts).
    }
  }
  return source.subscribe(handler);
}

async function readJsonlEvents(path: string): Promise<AdapterEvent[]> {
  const content = await readFile(path, 'utf8').catch(() => '');
  if (!content) return [];
  const events: AdapterEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as AdapterEvent);
    } catch {
      // Skip malformed lines rather than failing the whole replay.
      // A truncated tail (writer crashed mid-write) shouldn't block a TUI.
    }
  }
  return events;
}

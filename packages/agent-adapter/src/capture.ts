import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CaptureEvent, CaptureSink } from './types.ts';

/**
 * Redacts credentials from capture payloads before they hit disk.
 *
 * MVP-0 verification gate: after running the example, no `sk-ant-*` / `sk-*` /
 * `AIza*` pattern may appear in any capture file. This function is the only
 * thing standing between an accidental log of a request payload and a leaked
 * secret. It guards both adapters' captures.
 *
 * TODO(you): implement this body. ~5–10 lines. The decisions that shape it:
 *
 *   1. Patterns. Anthropic: /sk-ant-[A-Za-z0-9_-]{16,}/. OpenAI: /sk-[A-Za-z0-9_-]{20,}/.
 *      Google: /AIza[A-Za-z0-9_-]{20,}/. Future providers add patterns. Where
 *      does the registry live — here, or imported from auth-lib?
 *
 *   2. Depth. Anthropic SDK responses are deep. Top-level only is faster;
 *      walk-everything is safer but allocates per write.
 *
 *   3. Replacement. "[REDACTED]" preserves JSON shape (downstream parsers OK)
 *      vs. stripping the field entirely (smaller surface).
 *
 * Constraint: pure, synchronous, allocation-conscious — fires per write.
 *
 * @see examples/verify-no-leak.ts — the gate this function must pass.
 */
export function redactCapture(event: CaptureEvent): CaptureEvent {
  return event;
}

export class FileCaptureSink implements CaptureSink {
  constructor(private readonly path: string) {}

  async write(event: CaptureEvent): Promise<void> {
    const redacted = redactCapture(event);
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(redacted) + '\n', 'utf8');
  }

  async close(): Promise<void> {}
}

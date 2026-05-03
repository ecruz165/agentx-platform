import { redactEvent } from './capture.ts';

/**
 * The structured event types every adapter emits during invoke().
 *
 * Producers (adapters) emit; consumers (file writer, console renderer, server-side
 * job bus, future SSE bridges) subscribe. The shape stays flat and JSON-serializable
 * so any subscriber — local file, terminal, network — can render it without
 * adapter-specific knowledge.
 */
export type AdapterEvent =
  | {
      kind: 'request';
      ts: string;
      system?: string;
      user: string;
      model: string;
      provider?: string;
    }
  | {
      kind: 'response';
      ts: string;
      text: string;
      raw?: unknown;
    }
  | {
      kind: 'error';
      ts: string;
      message: string;
      cause?: unknown;
    };

export interface AdapterEventSource {
  subscribe(handler: (event: AdapterEvent) => void): () => void;
}

export class AdapterEventBus implements AdapterEventSource {
  private readonly handlers = new Set<(event: AdapterEvent) => void>();

  subscribe(handler: (event: AdapterEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(event: AdapterEvent): void {
    const safe = redactEvent(event);
    for (const handler of this.handlers) {
      try {
        handler(safe);
      } catch {
        // One subscriber's failure must not stop delivery to others or
        // propagate back into the producing adapter's invoke() path.
      }
    }
  }
}

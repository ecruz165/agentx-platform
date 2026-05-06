import { redactEvent } from './capture.ts';

/**
 * Per-invocation token usage. Field shapes mirror the OpenAI-style
 * `usage` object that most providers' responses carry. Anthropic's
 * SDK reports input/output names; we normalize to prompt/completion.
 *
 * All fields are optional — different providers report different
 * subsets, and some (e.g. OpenCode CLI) report nothing. Consumers
 * should treat absent fields as "unknown", not zero.
 */
export interface TokenUsage {
  /** Tokens in the prompt sent to the model. */
  promptTokens?: number;
  /** Tokens generated in the completion. */
  completionTokens?: number;
  /** promptTokens + completionTokens. Some providers only report this. */
  totalTokens?: number;
}

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
      /** Token usage for this single invoke, when the upstream provider
       *  reports it. Optional because not every adapter has access to
       *  structured usage (e.g., OpenCode CLI returns plain text via
       *  stdout, no token counts). Per memory `project_three_axis_binding`-
       *  era token-visibility work — surfaces "what did this call cost"
       *  to consumers (TUI, billing dashboards) without each one needing
       *  to re-parse the raw response. */
      usage?: TokenUsage;
    }
  | {
      kind: 'error';
      ts: string;
      message: string;
      cause?: unknown;
    }
  | {
      // Loader (context-loader-cli) progress event, bridged onto the JobBus
      // when a job's "agent" is actually an ingestion worker. Keeps the
      // existing JobBus + SSE infrastructure usable without a parallel
      // event-stream pipeline. The inner kind is the loader's IngestionEvent
      // kind ('item-walked' | 'chunk-produced' | 'node-written' | …).
      kind: 'loader-event';
      ts: string;
      /** Summary counters carried along so consumers don't have to replay
       *  the full event log to know "how far is this loader." */
      counts: {
        files: number;
        chunks: number;
        nodes: number;
        edges: number;
        vectors: number;
        errors: number;
      };
      /** The most recent file the loader walked (truncated for display). */
      lastItem?: string;
      /** Inner LoaderEvent kind so consumers can render different states
       *  (e.g., 'source-completed' should look different from 'item-walked'). */
      innerKind: string;
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

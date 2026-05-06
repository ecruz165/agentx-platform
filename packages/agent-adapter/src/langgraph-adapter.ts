/**
 * LangGraphAdapter — wraps a compiled LangGraph as an AgentAdapter.
 *
 * Per memory `project_langgraph_two_scopes`: LangGraph applies at two
 * agentx scopes — admin coordinator workflows in harness-server, and
 * sophisticated user agents in harness-pipeline. Both scopes use this
 * adapter; the difference is only WHICH compiled graph gets passed in.
 *
 * The adapter treats a LangGraph as a single "agent" from the harness's
 * perspective: one `invoke()` runs the graph from start to end and
 * returns the final state's response field. Internal graph nodes — tool
 * calls, conditional edges, sub-graphs — are invisible to runJob; the
 * orchestrator just sees a normal agent that takes input and returns
 * output.
 *
 * Event surface: emits 'request' before invoking the graph and 'response'
 * after. Per-node events from LangGraph itself are NOT bridged in this
 * v1 cut — adding them would require subscribing to the graph's
 * `streamEvents` and translating LangChain event types to AdapterEvent.
 * Worth doing once we have telemetry consumers; out of scope for the
 * foundation slice.
 *
 * What this v1 does NOT do:
 *   - LangChain ChatModel wrapping (so graph nodes can call `bindingToAdapter`-
 *     resolved LLMs through the harness's auth/dispatch). For now, graphs
 *     are responsible for their own LLM calls — typically by being passed
 *     a pre-constructed ChatModel as part of their config. Slice 10a-2
 *     wires the architecture-aware ChatModel.
 *   - Streaming responses. invoke() returns the full final-state response
 *     after the graph completes.
 *   - State persistence / checkpointing. Caller passes a fresh graph
 *     instance per invoke (or a graph compiled with their preferred
 *     checkpointer).
 */

import { AdapterEventBus } from './events.ts';
import type { AgentAdapter, InvocationSpec } from './types.ts';

/**
 * Generic input/output accepted by LangGraph's compiled graph. We don't
 * narrow further — LangGraph state shapes are user-defined.
 */
type GraphInput = Record<string, unknown>;
type GraphOutput = Record<string, unknown>;

/**
 * Compiled LangGraph contract — minimal structural type that exposes
 * `invoke(input) → Promise<output>`. Structural typing (rather than
 * `Runnable<I, O>` from @langchain/core) keeps this adapter compatible
 * with whatever specific compiled-graph shape `StateGraph.compile()`
 * returns. LangGraph's actual return type uses heavy generic state-
 * extraction types we can't easily mirror; structural-only fits any
 * compiled graph and any future LangGraph version that preserves the
 * `invoke()` method signature.
 */
export interface CompiledGraph {
  invoke(input: GraphInput, options?: unknown): Promise<GraphOutput>;
}

export interface LangGraphAdapterOptions {
  /** The compiled LangGraph this adapter runs. */
  graph: CompiledGraph;
  /**
   * Field name on the graph's final state that holds the response text.
   * The adapter returns `result[responseKey]` from `invoke()`. Default:
   * `'output'`.
   */
  responseKey?: string;
  /**
   * How to construct the initial state from the InvocationSpec. Default:
   * `{ input: spec.user, system: spec.system }`. Override to map the
   * harness's two-field shape (system + user) into your graph's specific
   * channel structure.
   */
  buildInitialState?: (spec: InvocationSpec) => GraphInput;
  /**
   * Tag forwarded into the request event (`event.model` field). Useful
   * for observability — surface "this agent is graph X" rather than the
   * generic "langgraph". Default: `'langgraph'`.
   */
  graphLabel?: string;
}

export class LangGraphAdapter implements AgentAdapter {
  readonly events = new AdapterEventBus();

  constructor(private readonly opts: LangGraphAdapterOptions) {}

  async invoke(spec: InvocationSpec): Promise<string> {
    const buildInitial =
      this.opts.buildInitialState ??
      ((s: InvocationSpec): GraphInput =>
        s.system !== undefined ? { input: s.user, system: s.system } : { input: s.user });
    const responseKey = this.opts.responseKey ?? 'output';
    const graphLabel = this.opts.graphLabel ?? 'langgraph';

    this.events.emit({
      kind: 'request',
      ts: new Date().toISOString(),
      system: spec.system,
      user: spec.user,
      model: graphLabel,
    });

    let result: GraphOutput;
    try {
      result = await this.opts.graph.invoke(buildInitial(spec));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.events.emit({
        kind: 'error',
        ts: new Date().toISOString(),
        message,
        cause: err instanceof Error ? err : undefined,
      });
      throw err;
    }

    const raw = result[responseKey];
    const text = typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw);

    this.events.emit({
      kind: 'response',
      ts: new Date().toISOString(),
      text,
      raw: result,
    });
    return text;
  }
}

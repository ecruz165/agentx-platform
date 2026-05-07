/**
 * Phase 4 runtime — compile a FlowDef into a runnable LangGraph StateGraph.
 *
 * This module is the bridge between the static FlowDef catalog (nodes +
 * edges + tags) and an executable graph. It owns:
 *
 *   - FlowState — the StateGraph state schema (jobId, output, messages,
 *     attempts, lastExit, rejectionPayload).
 *   - compileFlow(flow, executors) — turn a FlowDef into a compiled graph,
 *     wiring per-edge routing logic and per-tag node wrappers.
 *   - buildRouter — converts a node's outgoing edges into a single
 *     ConditionalEdgeRouter callable that LangGraph attaches via
 *     addConditionalEdges.
 *   - evalExpression — predicate evaluator for conditional edges. Handles
 *     literal + jsonpath today; `js` kind throws (no sandbox wired yet).
 *   - linearFlowFromAgents — synthesize a trigger→agents…→END FlowDef from
 *     a flat agent list. Lets legacy callers (every existing JobRecord
 *     submission today) drive the new graph executor without changing
 *     their fixture shape.
 *
 * Concerns deliberately NOT here:
 *   - Adapter dispatch / auth / bus events. The caller (orchestrator.ts)
 *     builds the per-node executor map and passes it in. This file knows
 *     nothing about RunJobDeps.
 *   - JobRecord mutation. Same reason — the wrapping runJob owns side-
 *     effects.
 *   - Per-step-kind logic. The injected executor map encodes which TaskStep
 *     ids run as what; this file just routes.
 */

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { AgentDef, Edge, Expression, FlowDef, RejectionPayload, TaskStep } from './catalog.ts';

/**
 * Per-node exit signal. Drives error/fallback/reject routing in the
 * conditional-edge router. Set by every node executor; the router reads it
 * to choose the next node id.
 */
export interface NodeExit {
  nodeId: string;
  kind: 'success' | 'error' | 'reject';
  /** Set when kind === 'error'. */
  errorName?: string;
  errorMessage?: string;
}

/**
 * StateGraph state schema for compiled flows. Uses Annotation.Root to
 * match the existing entry-coordinator + checkout-coordinator graphs in
 * harness-server. Two channel patterns are reducer-merged (messages,
 * attempts) so multiple parallel paths can write without clobbering;
 * everything else uses last-write-wins.
 */
export const FlowState = Annotation.Root({
  /** The job this graph instance is executing. Threaded into node
   *  executors via the deps map (not the state itself), but kept here
   *  for diagnostic prints + future per-event tagging. */
  jobId: Annotation<string>,
  /** Accumulating text output. Each successful agent step writes here;
   *  the next step reads it as the user prompt. Equivalent to the old
   *  orchestrator's `priorOutput` local. */
  output: Annotation<string>,
  /** Append-only message log. Future use: structured chat history for
   *  agents that work better with full message turns vs raw text. The
   *  reducer concatenates so parallel branches don't clobber. */
  messages: Annotation<unknown[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  /** Per-node attempt counter. Reject edges form cycles; the rejecting
   *  node increments its own counter on each pass. The router compares
   *  against the reject edge's maxAttempts. Reducer merges so the
   *  counter survives across the cycle. */
  attempts: Annotation<Record<string, number>>({
    reducer: (acc, partial) => ({ ...acc, ...partial }),
    default: () => ({}),
  }),
  /** Last node's exit signal. Replace-on-write; only the most recent
   *  exit drives routing. */
  lastExit: Annotation<NodeExit | null>({
    reducer: (_, n) => n,
    default: () => null,
  }),
  /** Rejection payload from gate / approval-tagged nodes. Carries reason,
   *  steering, findings, attempt counter. The receiving node (target of
   *  the reject edge) reads this as its primary input context. */
  rejectionPayload: Annotation<RejectionPayload | null>({
    reducer: (_, n) => n,
    default: () => null,
  }),
});

export type FlowStateT = typeof FlowState.State;

/**
 * Per-node executor function. Receives the current flow state and returns
 * a partial-state delta. Should NEVER throw under normal flow conditions
 * — instead return `{ lastExit: { kind: 'error', ... } }` so the router
 * can dispatch to the error edge. A genuine throw bypasses error edges
 * and propagates up to the caller (typically `runJob`), terminating the
 * job with status='failed'.
 */
export type NodeExecutor = (state: FlowStateT) => Promise<Partial<FlowStateT>>;

export interface CompileFlowOptions {
  flow: FlowDef;
  /** Map step.id → executor. Caller is responsible for building these
   *  from per-kind logic (agent runner, tool dispatch, gate evaluator,
   *  …). Missing ids fall through to a no-op executor that records a
   *  success exit — useful for steps that are inert pass-throughs. */
  executors: Map<string, NodeExecutor>;
}

/**
 * Compile a FlowDef into a runnable LangGraph. Returns a compiled graph
 * the caller invokes via `graph.invoke(initialState)`.
 *
 * Topology: every TaskStep becomes a node; every Edge contributes to the
 * per-source-node router. The trigger node receives `addEdge(START, …)`;
 * terminal nodes (no outgoing edges) receive `addEdge(…, END)`.
 *
 * Tags wrap their host node's executor with side-effects (Approval =
 * interrupt; Suspend = checkpoint; Loop = self-cycle until predicate). Tag
 * wrappers are stubs in this slice; full semantics land in follow-up
 * commits.
 */
export function compileFlow(opts: CompileFlowOptions) {
  const { flow, executors } = opts;
  const trigger = flow.nodes.find((n) => n.kind === 'trigger');
  if (!trigger) {
    throw new Error(`flow "${flow.id}" has no trigger node`);
  }

  // biome-ignore lint/suspicious/noExplicitAny: builder type evolves per addNode call (LangGraph's chained-builder generics rotate the type after each addNode/addEdge). The runtime is correct; the static path-dependent types are too narrow for our dynamic-iteration construction.
  const builder: any = new StateGraph(FlowState);

  for (const node of flow.nodes) {
    const exec = executors.get(node.id) ?? defaultExecutor(node.id);
    const wrapped = wrapWithTags(node, exec);
    builder.addNode(node.id, wrapped);
  }

  builder.addEdge(START, trigger.id);

  const edgesBySource = groupEdgesBySource(flow.edges);
  for (const node of flow.nodes) {
    const out = edgesBySource.get(node.id) ?? [];
    if (out.length === 0) {
      builder.addEdge(node.id, END);
      continue;
    }
    builder.addConditionalEdges(node.id, buildRouter(node.id, out));
  }

  return builder.compile();
}

/**
 * Build a ConditionalEdgeRouter for a single source node, given its
 * outgoing edges. Edge precedence (validator guarantees max 1 of each
 * error/fallback/reject):
 *
 *   1. exit.kind === 'reject' + reject edge present → cycle back if
 *      attempts < maxAttempts; else escalate or throw per onMaxAttempts.
 *   2. exit.kind === 'error' + error edge present → route to error
 *      target. No error edge → throw (propagates to runJob).
 *   3. Success path: try conditional edges in declaration order;
 *      first predicate match wins.
 *   4. Sequence edge as default forward.
 *   5. Fallback edge as catchall when nothing else fires.
 *   6. END.
 */
export function buildRouter(nodeId: string, out: readonly Edge[]): (state: FlowStateT) => string {
  const seq = out.find((e) => e.type === 'sequence');
  const conds = out.filter(
    (e): e is Extract<Edge, { type: 'conditional' }> => e.type === 'conditional',
  );
  const fb = out.find((e) => e.type === 'fallback');
  const err = out.find((e) => e.type === 'error');
  const rej = out.find((e): e is Extract<Edge, { type: 'reject' }> => e.type === 'reject');

  return (state: FlowStateT): string => {
    const exit = state.lastExit;

    if (exit?.kind === 'reject' && rej) {
      const max = rej.maxAttempts ?? 3;
      const attempts = state.attempts[nodeId] ?? 0;
      if (attempts < max) {
        return rej.to;
      }
      const onMax = rej.onMaxAttempts;
      if (onMax?.kind === 'escalate') {
        return onMax.to;
      }
      throw new Error(`reject limit reached for node "${nodeId}" (${attempts}/${max} attempts)`);
    }

    if (exit?.kind === 'error') {
      if (err) return err.to;
      throw new Error(
        `unhandled error at node "${nodeId}": ${exit.errorMessage ?? exit.errorName ?? 'unknown'}`,
      );
    }

    for (const c of conds) {
      if (evalExpression(c.condition, state)) {
        return c.to;
      }
    }
    if (seq) return seq.to;
    if (fb) return fb.to;
    return END;
  };
}

/**
 * Predicate evaluator for conditional edge expressions.
 *
 *   - literal: returns the value coerced to boolean (truthy check).
 *   - jsonpath: evaluates `$.path.into.state` against current state;
 *     truthy result counts as match. Minimal supported path syntax —
 *     `$.field` and `$.field.subfield`. No array indexing, filters, or
 *     wildcards yet (add as the catalog calls for them).
 *   - js: NOT YET SUPPORTED. Throws. Catalog authors should express
 *     predicates as jsonpath against state, or use literal for boolean
 *     gates. When a real sandbox lands (vm2 / isolated-vm) we'll wire
 *     this to evaluate `expr.expression` in a sandboxed context.
 */
export function evalExpression(expr: Expression, state: FlowStateT): boolean {
  switch (expr.kind) {
    case 'literal':
      return Boolean(expr.value);
    case 'jsonpath':
      return Boolean(resolveJsonPath(expr.path, state));
    case 'js':
      throw new Error('"js" expression kind is not yet supported — use jsonpath or literal');
  }
}

function resolveJsonPath(path: string, state: unknown): unknown {
  if (path === '$') return state;
  if (!path.startsWith('$.')) return undefined;
  const parts = path.slice(2).split('.');
  let cur: unknown = state;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function groupEdgesBySource(edges: readonly Edge[]): Map<string, Edge[]> {
  const m = new Map<string, Edge[]>();
  for (const edge of edges) {
    const arr = m.get(edge.from) ?? [];
    arr.push(edge);
    m.set(edge.from, arr);
  }
  return m;
}

function defaultExecutor(nodeId: string): NodeExecutor {
  return async () => ({ lastExit: { nodeId, kind: 'success' } });
}

function wrapWithTags(_step: TaskStep, exec: NodeExecutor): NodeExecutor {
  // Tag wrappers are stubs in this slice. The inner executor runs as-is;
  // Approval (interrupt), Suspend (checkpoint), and Loop (cycle until
  // predicate) land in follow-up commits.
  return exec;
}

/**
 * Synthesize a linear FlowDef from a flat agent list. Used by runJob's
 * legacy compatibility path: every existing JobRecord submission
 * provides agents directly, not a FlowDef. The synthesized flow is
 *
 *   trigger:__entry → agents[0] → agents[1] → … → agents[N-1] → END
 *
 * with sequence edges throughout. Coordinator agents are filtered out
 * to match the historical orchestrator behavior (hardcoded skip on
 * id === 'coordinator' / 'checkout-coordinator').
 */
export function linearFlowFromAgents(id: string, agents: readonly { id: string }[]): FlowDef {
  const real = agents.filter((a) => a.id !== 'coordinator' && a.id !== 'checkout-coordinator');
  const TRIGGER_ID = '__trigger';
  const nodes: TaskStep[] = [
    {
      id: TRIGGER_ID,
      kind: 'trigger',
      config: { kind: 'manual' },
    },
    ...real.map(
      (a): TaskStep => ({
        id: a.id,
        kind: 'agent',
        // The executor map looks up by step.id; the AgentDef body isn't
        // consulted here. Synthesize a minimal placeholder.
        config: { agent: { id: a.id } as AgentDef },
      }),
    ),
  ];
  const edges: Edge[] = [];
  let prev = TRIGGER_ID;
  for (const a of real) {
    edges.push({ from: prev, to: a.id, type: 'sequence' });
    prev = a.id;
  }
  return { id, nodes, edges };
}

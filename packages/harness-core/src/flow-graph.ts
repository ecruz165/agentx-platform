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

import {
  Annotation,
  type BaseCheckpointSaver,
  END,
  interrupt,
  MemorySaver,
  START,
  StateGraph,
} from '@langchain/langgraph';
import type {
  AgentDef,
  ApprovalTag,
  Edge,
  Expression,
  FlowDef,
  LoopTag,
  RejectionPayload,
  SuspendTag,
  TaskStep,
} from './catalog.ts';
import type { ChangedFile } from './changed-files.ts';

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
  /**
   * In-flight operator steering — append-only string array. Operators
   * (or peer agents) push entries via `steerJob(jobId, text, deps)`;
   * the agent executor prepends the joined text into the agent's
   * system prompt on its next adapter invocation. Reducer concatenates
   * so multiple steering pushes accumulate; default is empty.
   *
   * Two access modes for agents:
   *   1. Passive — the agent executor reads this and prepends to the
   *      systemPrompt automatically. Works for any adapter.
   *   2. Active — Bash-capable agents can `harness steering check
   *      --job $HARNESS_JOB_ID` between LLM calls within a single
   *      node, getting fresh steering without waiting for the next
   *      node-tick. SKILL.md teaches the procedure.
   */
  steering: Annotation<string[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  /**
   * Cooperative-cancellation flag. `cancelJob(jobId, reason, deps)`
   * sets this true via the checkpointer. The agent executor checks at
   * each node-tick boundary; when set, marks the agent + job as
   * 'cancelled' and short-circuits to a terminal status without
   * invoking the adapter. Hard cancellation (kill the in-flight
   * adapter call) is NOT supported here — that requires per-adapter
   * cancellation primitives the adapter layer doesn't yet expose.
   */
  cancelRequested: Annotation<boolean>({
    reducer: (_, n) => n,
    default: () => false,
  }),
  cancelReason: Annotation<string | null>({
    reducer: (_, n) => n,
    default: () => null,
  }),
  /**
   * Staged changes across product repos, populated by the agent
   * executor after each successful node-tick (and surfaced via
   * ApprovalRequest at HITL interrupts). Reducer merges by `id`
   * (`${repo}::${path}`): the latest entry for a path wins, so
   * agents that re-stage a file replace earlier entries cleanly.
   * Entries that no longer appear in a fresh discovery still persist
   * — once observed in state, a file stays in the changedFiles list
   * until the job terminates. Reviewers see the cumulative diff
   * surface, not a momentary snapshot.
   */
  changedFiles: Annotation<ChangedFile[]>({
    reducer: (existing, incoming) => {
      const merged = new Map<string, ChangedFile>();
      for (const c of existing) merged.set(c.id, c);
      for (const c of incoming) merged.set(c.id, c);
      return [...merged.values()];
    },
    default: () => [],
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
  /** Checkpointer for state persistence. Required for Approval and Suspend
   *  tags (LangGraph's interrupt() needs a checkpointer to persist state
   *  while paused) — defaults to MemorySaver when any node carries either
   *  tag. Caller can pass a Postgres/SQLite saver to make awaiting-
   *  approval / suspended jobs survive process restarts. */
  checkpointer?: BaseCheckpointSaver;
}

/**
 * Payload surfaced via LangGraph's interrupt() when an Approval-tagged
 * node pauses for review. The reviewer (or harness-server's HITL UI)
 * inspects this, decides approve/reject, and resumes via
 * `Command({ resume: ApprovalResume })`.
 */
export interface ApprovalRequest {
  /** Discriminator — distinguishes approval from suspend interrupts. */
  kind: 'approval';
  /** The original (untagged) node id whose output is being reviewed.
   *  The synthetic approval node has id `${nodeId}__approval`. */
  nodeId: string;
  /** Org role authorized to approve (from the ApprovalTag). */
  assigneeRole: string;
  /** Time-to-respond before the harness should auto-reject (caller's
   *  responsibility to enforce; harness-core just surfaces the value). */
  slaMs: number;
  /** Optional structured input schema the reviewer fills in. */
  steeringInputs?: ApprovalTag['steeringInputs'];
  /** The output text the reviewer is approving — pulled from
   *  `state.output` at interrupt time. */
  content: string;
  /** 1-indexed attempt counter — increments each time the gate runs. */
  attempt: number;
  /** Staged file changes the reviewer can inspect — pulled from
   *  `state.changedFiles` at interrupt time. Empty when no agent has
   *  staged changes (or no product repos are wired). UI uses this to
   *  render a sidebar of files for diff/content fetch. */
  changes: ChangedFile[];
}

export interface ApprovalResume {
  decision: 'approve' | 'reject';
  /** Reviewer-provided steering text (free-form) or structured fields
   *  matching `steeringInputs`. Becomes the rejectionPayload.steering
   *  on reject; ignored on approve. */
  steering?: unknown;
}

/**
 * Payload surfaced when a Suspend-tagged node pauses. Caller (harness-
 * server) is responsible for scheduling the resume — timer-based via
 * setTimeout/cron, or event-based via subscription to the matched
 * eventType. Resume value is unused (Suspend has no decision; resume
 * is the "wake up" signal itself).
 */
export interface SuspendRequest {
  kind: 'suspend';
  nodeId: string;
  trigger: SuspendTag['trigger'];
  /** Staged file changes pending review while the job is suspended.
   *  Same surface as ApprovalRequest.changes — operators inspecting a
   *  long-running suspend (e.g., overnight timer) can preview what
   *  the agent did before it paused. */
  changes: ChangedFile[];
}

/**
 * Compile a FlowDef into a runnable LangGraph. Returns a compiled graph
 * the caller invokes via `graph.invoke(initialState)`.
 *
 * Topology pipeline:
 *   1. Rewrite for Approval/Suspend tags — insert synthetic interrupt
 *      nodes and redirect outgoing edges. Required because LangGraph's
 *      interrupt() re-runs the entire node on resume; isolating the
 *      interrupt in its own node prevents re-running the inner work
 *      (e.g., re-invoking an LLM).
 *   2. Trigger lookup + START edge.
 *   3. Per-node executor — original-step executors come from the
 *      `executors` map; synthetic interrupt nodes carry tag-specific
 *      executors built here. Loop tag is wrapped without a topology
 *      rewrite — it iterates the inner inside a single node.
 *   4. Per-source-node ConditionalEdgeRouter from each node's outgoing
 *      edges (sequence/conditional/error/fallback/reject precedence).
 *   5. Compile with checkpointer — defaults to MemorySaver when any
 *      node carries an Approval or Suspend tag, since interrupt()
 *      requires a checkpointer to persist paused state.
 */
export function compileFlow(opts: CompileFlowOptions) {
  const { executors } = opts;

  // Step 1: rewrite topology for Approval/Suspend tags.
  const flow = rewriteFlowForInterruptTags(opts.flow);

  const trigger = flow.nodes.find((n) => n.kind === 'trigger');
  if (!trigger) {
    throw new Error(`flow "${flow.id}" has no trigger node`);
  }

  // biome-ignore lint/suspicious/noExplicitAny: builder type evolves per addNode call (LangGraph's chained-builder generics rotate the type after each addNode/addEdge). The runtime is correct; the static path-dependent types are too narrow for our dynamic-iteration construction.
  const builder: any = new StateGraph(FlowState);

  for (const node of flow.nodes) {
    const baseExec =
      // Synthetic approval / suspend nodes carry tag metadata that the
      // executor reads inline; they aren't in the caller-supplied map.
      // Built-in executors (gate) apply to stateless step kinds that
      // need no runJob deps — caller can still override by putting an
      // explicit entry in the executors map.
      isSyntheticApprovalNode(node)
        ? makeApprovalExecutor(node)
        : isSyntheticSuspendNode(node)
          ? makeSuspendExecutor(node)
          : (executors.get(node.id) ?? builtinExecutor(node) ?? defaultExecutor(node.id));
    const wrapped = wrapWithTags(node, baseExec);
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

  // Step 5: attach checkpointer.
  //
  // Always attach one (defaulting to MemorySaver) — not just for flows
  // with Approval/Suspend tags. Reasoning: the steerJob / cancelJob
  // primitives use graph.updateState() to write to the checkpointer
  // mid-flight, and operators expect to steer ANY in-flight job, not
  // only the ones with HITL gates. Without a checkpointer attached,
  // updateState throws.
  //
  // Cost: per-tick checkpoint writes (small for in-process MemorySaver,
  // ~Map.set). The graph is already cached on deps.graphs for the
  // lifetime of the job, so the checkpointer adds negligible memory
  // beyond what we already retain.
  //
  // Caller-supplied checkpointer wins, as before — production swaps in
  // PostgresSaver / SqliteSaver via opts.checkpointer.
  const checkpointer = opts.checkpointer ?? new MemorySaver();

  return builder.compile({ checkpointer });
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

/**
 * Per-step-kind built-in executor for stateless kinds that need no
 * external dependencies (no adapter, no broker, no subprocess).
 *
 *   - gate: evaluates GateConfig.assertions against state. Emits
 *     success when ALL hold; reject + RejectionPayload when ANY fails.
 *   - transform: evaluates TransformConfig.expression against state and
 *     writes the resolved value (stringified) to state.output. Always
 *     emits success — transforms are pure data shaping, not branching.
 *
 * Returns null for kinds that need runJob-supplied executors (agent,
 * tool, script, subflow) or are no-ops handled elsewhere (trigger).
 * Caller can still override any built-in by providing an explicit
 * entry in the executors map.
 */
function builtinExecutor(node: TaskStep): NodeExecutor | null {
  if (node.kind === 'gate') {
    return makeGateExecutor(node);
  }
  if (node.kind === 'transform') {
    return makeTransformExecutor(node);
  }
  return null;
}

/**
 * Gate executor — runs all assertions against the current state.
 *
 * All pass: returns `{ lastExit: { kind: 'success' } }`. Routing
 * proceeds via sequence/conditional edges as normal.
 *
 * Any fail: returns `{ lastExit: { kind: 'reject' }, rejectionPayload }`
 * with the failed assertion messages joined into `reason` and the
 * structured failures listed in `findings`. The router cycles back via
 * the gate's reject edge (validator restricts reject-source to gate or
 * approval-tagged nodes) with the attempt counter incrementing on the
 * gate node's id.
 *
 * Empty assertions list: trivially passes. Useful for "always-pass"
 * gates used as topology placeholders or as documentation of expected
 * conditions that hold by construction.
 *
 * Exported so tests + future tooling (gate-preview UI) can run it
 * standalone without compiling a full graph.
 */
export function makeGateExecutor(node: TaskStep): NodeExecutor {
  if (node.kind !== 'gate') {
    throw new Error(`makeGateExecutor: node "${node.id}" has kind "${node.kind}", expected "gate"`);
  }
  const config = node.config as {
    assertions?: ReadonlyArray<{ expression: Expression; message: string }>;
  };
  const assertions = config.assertions ?? [];
  const nodeId = node.id;

  return async (state) => {
    const failures: Array<{ message: string; expression: Expression }> = [];
    for (const assertion of assertions) {
      if (!evalExpression(assertion.expression, state)) {
        failures.push({ message: assertion.message, expression: assertion.expression });
      }
    }

    if (failures.length === 0) {
      return { lastExit: { nodeId, kind: 'success' } };
    }

    const attempts = state.attempts[nodeId] ?? 0;
    return {
      attempts: { [nodeId]: attempts + 1 },
      lastExit: { nodeId, kind: 'reject' },
      rejectionPayload: {
        reason: failures.map((f) => f.message).join('; '),
        findings: failures,
        attempt: attempts + 1,
      },
    };
  };
}

/**
 * Transform executor — evaluates the configured Expression against
 * current flow state and writes the resolved value to `state.output`.
 *
 *   - literal: writes expr.value verbatim (stringified for non-strings)
 *   - jsonpath: writes the jsonpath-resolved value (stringified)
 *   - js: throws (no sandbox; same as evalExpression)
 *
 * Always emits success. Transforms are pure data shaping — they don't
 * branch, don't reject, and don't fail under normal conditions.
 *
 * Stringification uses JSON.stringify for non-strings and pass-through
 * for strings; `undefined` results land as the literal string
 * `"undefined"` (catalogs that need "absent" semantics should guard
 * with a gate node first).
 *
 * Use cases: extracting structured fields from a prior agent's output,
 * coercing types between steps, computing derived values from state.
 *
 * Exported so tests + future tooling (catalog dry-run, expression
 * preview UI) can run a transform standalone.
 */
export function makeTransformExecutor(node: TaskStep): NodeExecutor {
  if (node.kind !== 'transform') {
    throw new Error(
      `makeTransformExecutor: node "${node.id}" has kind "${node.kind}", expected "transform"`,
    );
  }
  const config = node.config as { expression: Expression };
  const nodeId = node.id;

  return async (state) => {
    const value = resolveExpressionValue(config.expression, state);
    const output = typeof value === 'string' ? value : JSON.stringify(value);
    return {
      output,
      lastExit: { nodeId, kind: 'success' },
    };
  };
}

/**
 * Wrap a node executor with tag-driven behavior modifiers.
 *
 * Approval and Suspend tags are NOT applied here — they are handled by
 * the topology rewriter (rewriteFlowForInterruptTags) which inserts
 * synthetic interrupt nodes after the original. The original step's
 * executor runs as-is; the synthetic node owns the interrupt.
 *
 * Loop tag IS handled here, as a wrapper. The wrapper resolves the
 * iteration source from state, runs the inner once per item with the
 * item set as `state.output`, and aggregates results. No topology
 * rewrite needed — Loop is a within-node iteration, not a separate
 * graph node.
 */
function wrapWithTags(step: TaskStep, exec: NodeExecutor): NodeExecutor {
  if (!step.tags?.loop) return exec;
  return loopWrapper(step.id, step.tags.loop, exec);
}

// ─── Topology rewriter (Approval + Suspend tags) ──────────────────────────

/** Suffix appended to a tagged node's id to derive its synthetic
 *  approval node id. Exported only as a constant pattern; no public API
 *  surface depends on the literal value. */
const APPROVAL_SUFFIX = '__approval';
const SUSPEND_SUFFIX = '__suspend';

interface SyntheticApprovalNode extends TaskStep {
  __approvalTag: ApprovalTag;
}
interface SyntheticSuspendNode extends TaskStep {
  __suspendTag: SuspendTag;
}

function isSyntheticApprovalNode(node: TaskStep): node is SyntheticApprovalNode {
  return '__approvalTag' in node;
}
function isSyntheticSuspendNode(node: TaskStep): node is SyntheticSuspendNode {
  return '__suspendTag' in node;
}

/**
 * Rewrite a FlowDef so that every node carrying an Approval or Suspend
 * tag has a synthetic interrupt node inserted immediately after it. The
 * original node's outgoing edges are redirected to start from the
 * synthetic node — so the interrupt becomes the routing decision point.
 *
 * Why: LangGraph's interrupt() re-runs the entire host node on resume.
 * If Approval is wrapped around an LLM agent, the agent runs twice
 * (once before interrupt, once after) — wasteful and non-idempotent.
 * Splitting the work + interrupt into separate nodes means only the
 * interrupt node re-runs on resume; the work runs exactly once.
 *
 * Approval ⊥ Suspend per validator (TaskStepTags.approval and
 * .suspend cannot both be set), so a node gets at most one rewrite.
 * Loop tag is unaffected here — it's a wrapper, not a topology change.
 */
function rewriteFlowForInterruptTags(flow: FlowDef): FlowDef {
  const tagged = flow.nodes.filter(
    (n) => n.tags?.approval !== undefined || n.tags?.suspend !== undefined,
  );
  if (tagged.length === 0) return flow;

  const newNodes: TaskStep[] = [];
  const renames = new Map<string, string>();

  for (const node of flow.nodes) {
    if (node.tags?.approval) {
      const syntheticId = `${node.id}${APPROVAL_SUFFIX}`;
      const synthetic: SyntheticApprovalNode = {
        id: syntheticId,
        kind: 'agent',
        // The synthetic node has no real config; the executor pulls
        // tag data from __approvalTag rather than config.
        config: { agent: { id: syntheticId } as AgentDef },
        __approvalTag: node.tags.approval,
      };
      newNodes.push({ ...node, tags: undefined }, synthetic);
      renames.set(node.id, syntheticId);
    } else if (node.tags?.suspend) {
      const syntheticId = `${node.id}${SUSPEND_SUFFIX}`;
      const synthetic: SyntheticSuspendNode = {
        id: syntheticId,
        kind: 'agent',
        config: { agent: { id: syntheticId } as AgentDef },
        __suspendTag: node.tags.suspend,
      };
      newNodes.push({ ...node, tags: undefined }, synthetic);
      renames.set(node.id, syntheticId);
    } else {
      newNodes.push(node);
    }
  }

  const newEdges: Edge[] = [];
  // For every tagged-original node, insert a sequence edge → synthetic.
  for (const orig of tagged) {
    const syntheticId = renames.get(orig.id);
    if (!syntheticId) continue;
    newEdges.push({ from: orig.id, to: syntheticId, type: 'sequence' });
  }
  // Redirect existing edges that originated from a tagged node — their
  // `from` becomes the synthetic id (the interrupt is the new exit
  // point). Edges TO a tagged node are unchanged (the original still
  // runs first and is still the entry point).
  for (const edge of flow.edges) {
    const newFrom = renames.get(edge.from) ?? edge.from;
    newEdges.push({ ...edge, from: newFrom } as Edge);
  }

  return { ...flow, nodes: newNodes, edges: newEdges };
}

// ─── Tag-node executors ──────────────────────────────────────────────────

/**
 * Synthetic Approval node executor.
 *
 * On first execution: calls interrupt(...) with an ApprovalRequest
 * payload. The graph pauses; runJob picks up the interrupt from
 * `result.__interrupt__` and marks the JobRecord 'awaiting-approval'.
 *
 * On resume (Command({resume: ApprovalResume})): interrupt() returns
 * the resume value. The executor:
 *   - 'approve' → success exit (forward via sequence/conditional)
 *   - 'reject' → reject exit + RejectionPayload (route via reject edge;
 *     attempt counter increments on this synthetic node's id)
 */
function makeApprovalExecutor(node: SyntheticApprovalNode): NodeExecutor {
  const tag = node.__approvalTag;
  const nodeId = node.id;
  // Strip the suffix to recover the original (untagged) node id for
  // the user-facing payload.
  const originalId = nodeId.replace(new RegExp(`${APPROVAL_SUFFIX}$`), '');

  return async (state) => {
    const attempts = state.attempts[nodeId] ?? 0;

    const request: ApprovalRequest = {
      kind: 'approval',
      nodeId: originalId,
      assigneeRole: tag.assigneeRole,
      slaMs: tag.slaMs,
      ...(tag.steeringInputs ? { steeringInputs: tag.steeringInputs } : {}),
      content: state.output,
      attempt: attempts + 1,
      changes: state.changedFiles,
    };

    const resume = interrupt(request) as ApprovalResume;

    if (resume?.decision === 'approve') {
      // Forward-looking steering on approve: reviewer's steering text
      // appended to state.steering so DOWNSTREAM agents pick it up
      // via the existing passive-prepend path. (Reject cycles use
      // rejectionPayload.steering; approve uses the long-lived
      // state.steering channel — different semantic, same content.)
      const forward =
        typeof resume.steering === 'string' && resume.steering.length > 0
          ? { steering: [resume.steering] }
          : {};
      return {
        attempts: { [nodeId]: attempts + 1 },
        lastExit: { nodeId, kind: 'success' },
        ...forward,
      };
    }

    return {
      attempts: { [nodeId]: attempts + 1 },
      lastExit: { nodeId, kind: 'reject' },
      rejectionPayload: {
        reason: 'rejected by reviewer',
        ...(typeof resume?.steering === 'string' ? { steering: resume.steering } : {}),
        ...(resume?.steering !== undefined && typeof resume.steering !== 'string'
          ? { findings: resume.steering }
          : {}),
        attempt: attempts + 1,
      },
    };
  };
}

/**
 * Synthetic Suspend node executor.
 *
 * Calls interrupt(...) with a SuspendRequest payload. runJob marks the
 * JobRecord 'suspended'. The caller (harness-server) is responsible for
 * scheduling the resume — timer-based via setTimeout/cron, or event-
 * based via subscription.
 *
 * On resume (Command({resume})): the resume value is unused; suspend
 * has no decision, just a wake-up signal. The executor returns success.
 */
function makeSuspendExecutor(node: SyntheticSuspendNode): NodeExecutor {
  const tag = node.__suspendTag;
  const nodeId = node.id;
  const originalId = nodeId.replace(new RegExp(`${SUSPEND_SUFFIX}$`), '');

  return async (state) => {
    const request: SuspendRequest = {
      kind: 'suspend',
      nodeId: originalId,
      trigger: tag.trigger,
      changes: state.changedFiles,
    };
    interrupt(request);
    // Resume value is unused for suspend — wake-up is the signal.
    return {
      lastExit: { nodeId, kind: 'success' },
    };
  };
}

/**
 * Loop tag wrapper. Resolves the iteration source from state, runs the
 * inner executor once per item with `state.output` set to the item, and
 * aggregates outputs. Halts iteration on the first error or reject from
 * the inner.
 *
 * v1 supports `mode: 'sequential'` only — parallel mode requires a
 * cap-aware async pool and is deferred. `source: 'directory'` requires
 * filesystem traversal and is also deferred (catalog authors hit a
 * runtime error if they try it).
 *
 * Iterables resolve via the same Expression types used for conditional
 * edges, but here we want the RAW value (an array), not a boolean —
 * see resolveExpressionValue.
 */
function loopWrapper(nodeId: string, tag: LoopTag, inner: NodeExecutor): NodeExecutor {
  return async (state) => {
    if (tag.source === 'directory') {
      throw new Error(`Loop source: 'directory' is not yet supported (node "${nodeId}")`);
    }
    if (tag.mode === 'parallel') {
      throw new Error(
        `Loop mode: 'parallel' is not yet supported (node "${nodeId}") — use 'sequential'`,
      );
    }

    const raw = resolveExpressionValue(tag.path, state);
    if (!Array.isArray(raw)) {
      return {
        lastExit: {
          nodeId,
          kind: 'error',
          errorName: 'LoopPathError',
          errorMessage: `Loop path did not resolve to an array (got ${typeof raw})`,
        },
      };
    }

    const outputs: string[] = [];
    let lastDelta: Partial<FlowStateT> = {};

    for (const item of raw) {
      const itemInput = typeof item === 'string' ? item : JSON.stringify(item);
      const itemState: FlowStateT = { ...state, output: itemInput };
      const delta = await inner(itemState);

      if (delta.lastExit?.kind === 'error' || delta.lastExit?.kind === 'reject') {
        // Halt on first failure — preserves the per-item error so the
        // edge router can dispatch.
        return delta;
      }
      if (typeof delta.output === 'string') outputs.push(delta.output);
      lastDelta = delta;
    }

    return {
      ...lastDelta,
      output: outputs.join('\n---\n'),
      lastExit: { nodeId, kind: 'success' },
    };
  };
}

/**
 * Resolve an Expression to its raw value (used for Loop iteration). Like
 * evalExpression but returns the value rather than coercing to boolean.
 *
 *   - literal → expr.value
 *   - jsonpath → resolved value or undefined
 *   - js → throws (no sandbox; same as evalExpression)
 */
function resolveExpressionValue(expr: Expression, state: FlowStateT): unknown {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'jsonpath':
      return resolveJsonPath(expr.path, state);
    case 'js':
      throw new Error('"js" expression kind is not yet supported');
  }
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

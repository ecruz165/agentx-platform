/**
 * `kind: 'subflow'` step-kind executor + compile-time validator.
 *
 * v1 scope (this file):
 *   - Compose deterministic flows (gate, transform, tool, trigger, nested
 *     subflow). State passes through; output flows back into the parent.
 *
 * Out of v1 (deferred to a follow-up slice):
 *   - Agent nodes inside subflows (would require JobRecord agent
 *     registration to recurse through subflow targets — see
 *     `walkAgents` in catalog.ts which currently walks one flow level).
 *   - Approval / Suspend tags inside subflows. LangGraph's interrupt()
 *     is single-shot per node-invocation; propagating multiple inner
 *     pauses up to the parent requires a multi-resume coordinator that
 *     materially complicates the executor. Catalogs that need HITL
 *     gates should put them in the parent flow.
 *
 * Both deferrals are enforced at parent-compile time by
 * `validateSubflowGraph` — catalog authors learn at compile, not at
 * the first subflow tick.
 *
 * State flow:
 *   parent.state.output            ─►  inner.state.output  (passthrough)
 *   parent.state.changedFiles      ─►  inner.state.changedFiles
 *   parent.state.steering          ─►  inner.state.steering
 *   parent.state.cancelRequested   ─►  inner.state.cancelRequested
 *                                  ◄─  inner.state.output       (replaces parent)
 *                                  ◄─  inner.state.changedFiles (merged)
 *                                  ◄─  inner.state.steering     (appended)
 *
 * If `SubflowConfig.input` is set, its values are Expression-resolved
 * against the parent state, JSON-stringified, and used as the inner's
 * initial `output` (overriding the passthrough). Catalog authors who
 * need richer shaping should use a `transform` step before the subflow.
 */
import { CatalogError, type Expression, type FlowDef, type SubflowConfig, type TaskStep } from './catalog.ts';
import {
  compileFlow,
  type CompileFlowOptions,
  type FlowStateT,
  type NodeExecutor,
} from './flow-graph.ts';
import type { CompiledFlowGraph } from './orchestrator.ts';

/**
 * Resolves a `flowId` to its `FlowDef`. Same shape pattern as
 * `ToolResolver`. Returns undefined for unknown ids; the validator
 * surfaces missing flowIds as CatalogError at compile time.
 */
export type FlowResolver = (flowId: string) => FlowDef | undefined;

/**
 * Walk a parent flow's subflow nodes and validate each inner target
 * recursively. Surfaces cycles, missing flow ids, and v1-banned kinds
 * (agent / approval / suspend) as CatalogError. Catalog authors learn
 * at compile time rather than at first subflow execution.
 *
 * Returns a Map<parentNodeId, FlowDef> of the parent's *direct*
 * subflow children. Nested subflows are validated as part of the
 * recursive walk but NOT included in the returned map — the recursion
 * inside `compileNonAgentFlow` discovers them again at each level when
 * it builds executors.
 */
export function validateSubflowGraph(parent: FlowDef, resolver: FlowResolver): Map<string, FlowDef> {
  const directChildren = new Map<string, FlowDef>();

  function walk(
    flow: FlowDef,
    where: string,
    ancestorIds: ReadonlySet<string>,
    isRoot: boolean,
  ): void {
    const nextAncestors = new Set([...ancestorIds, flow.id]);

    for (const node of flow.nodes) {
      if (node.kind !== 'subflow') continue;
      const cfg = node.config as SubflowConfig;
      const innerId = cfg.flowId;
      const at = `${where}.nodes["${node.id}"]`;

      if (ancestorIds.has(innerId) || innerId === flow.id) {
        throw new CatalogError(
          `${at} subflow.flowId "${innerId}" forms a cycle (already present in parent chain: ${[...nextAncestors].join(' → ')})`,
        );
      }

      const inner = resolver(innerId);
      if (!inner) {
        throw new CatalogError(
          `${at} subflow.flowId "${innerId}" did not resolve — flow not found in catalog`,
        );
      }

      // Banned kinds + tags. Each rejection includes the offending
      // node id from the inner flow so catalog authors can fix the
      // exact spot.
      for (const innerNode of inner.nodes) {
        if (innerNode.kind === 'agent') {
          throw new CatalogError(
            `${at} subflow target "${innerId}" contains agent node "${innerNode.id}" — agents in subflows are not supported in v1 (put agents in the parent flow)`,
          );
        }
        if (innerNode.tags?.approval) {
          throw new CatalogError(
            `${at} subflow target "${innerId}" contains node "${innerNode.id}" with approval tag — interrupt propagation from subflows is not supported in v1 (put HITL gates in the parent flow)`,
          );
        }
        if (innerNode.tags?.suspend) {
          throw new CatalogError(
            `${at} subflow target "${innerId}" contains node "${innerNode.id}" with suspend tag — interrupt propagation from subflows is not supported in v1`,
          );
        }
      }

      // Only the parent's direct subflow children land in the
      // returned map. Deeper levels are still validated via recursion,
      // but the orchestrator's compileNonAgentFlow rediscovers them
      // when it walks each inner level.
      if (isRoot) {
        directChildren.set(node.id, inner);
      }

      walk(inner, `${at}.subflow:${innerId}`, nextAncestors, false);
    }
  }

  walk(parent, `flow:${parent.id}`, new Set(), true);
  return directChildren;
}

/**
 * Build the per-node executor for a `kind: 'subflow'` TaskStep. The
 * caller (orchestrator.runJob) is responsible for:
 *   1. Calling validateSubflowGraph to surface compile errors.
 *   2. Pre-compiling each inner FlowDef into a CompiledFlowGraph
 *      (typically via compileFlow with the parent's executor map
 *      filtered to inner nodes — though for v1's banned-kind set,
 *      no filter is needed: gate/transform/tool/trigger executors
 *      either come from builtins or from the supplied tool resolver).
 *   3. Passing the compiled inner graph in here.
 *
 * Returns a NodeExecutor with the same shape as agent / tool / gate
 * executors (partial-state delta with lastExit).
 */
export function makeSubflowExecutor(
  node: TaskStep,
  innerGraph: CompiledFlowGraph,
): NodeExecutor {
  if (node.kind !== 'subflow') {
    throw new Error(
      `makeSubflowExecutor: node "${node.id}" has kind "${node.kind}", expected "subflow"`,
    );
  }
  const config = node.config as SubflowConfig;
  const nodeId = node.id;
  // Per-executor invocation counter so Loop+subflow gets a fresh
  // checkpoint thread per iteration rather than reusing the prior
  // pause state. Closure-local state is fine — the executor is built
  // once per parent-job invocation.
  let invocationCount = 0;

  return async (state) => {
    invocationCount += 1;
    // Compute a deterministic-but-unique thread_id for this inner
    // invocation. Format scheme: `${parentJobId}::sub::${parentNodeId}::${seq}`
    // — `::sub::` makes it clear in checkpointer logs which threads
    // are nested vs top-level.
    const innerThreadId = `${state.jobId}::sub::${nodeId}::${invocationCount}`;
    const innerConfig = { configurable: { thread_id: innerThreadId } };

    // Build inner initial state. Passthrough is the default; an
    // explicit SubflowConfig.input overrides the inner's starting
    // `output` after Expression resolution.
    let innerOutput = state.output;
    if (config.input !== undefined) {
      try {
        innerOutput = stringifyInputOverride(config.input, state);
      } catch (err) {
        return {
          lastExit: {
            nodeId,
            kind: 'error',
            errorName: 'SubflowInputResolutionError',
            errorMessage: (err as Error).message,
          },
        };
      }
    }

    const initialState = {
      jobId: state.jobId,
      output: innerOutput,
      messages: [],
      attempts: {},
      lastExit: null,
      rejectionPayload: null,
      // Pass-down on entry; merge-up on exit.
      steering: state.steering,
      cancelRequested: state.cancelRequested,
      cancelReason: state.cancelReason,
      changedFiles: state.changedFiles,
    };

    let result: Record<string, unknown>;
    try {
      result = await innerGraph.invoke(initialState, innerConfig);
    } catch (err) {
      return {
        lastExit: {
          nodeId,
          kind: 'error',
          errorName: 'SubflowError',
          errorMessage: (err as Error).message,
        },
      };
    }

    // Map inner result back to a parent-state delta.
    //
    // Inner exits we treat as parent failure:
    //   - kind: 'error' — explicit error from any inner node
    //   - kind: 'reject' — gate rejected without a reject-edge handler
    //     in the inner flow. With no inner handler, the rejection is
    //     unhandled at the subflow boundary, so it propagates as a
    //     parent error. Catalog authors who want to recover should
    //     wire a reject edge inside the subflow.
    //
    // Both modes surface as `kind: 'error'` on the parent so the
    // parent's error edge (if any) catches them uniformly.
    const innerExit = result.lastExit as FlowStateT['lastExit'];
    if (innerExit?.kind === 'error') {
      return {
        lastExit: {
          nodeId,
          kind: 'error',
          errorName: innerExit.errorName ?? 'SubflowError',
          errorMessage: innerExit.errorMessage ?? `subflow "${config.flowId}" terminated with error`,
        },
      };
    }
    if (innerExit?.kind === 'reject') {
      const payload = result.rejectionPayload as
        | { reason?: string }
        | null
        | undefined;
      return {
        lastExit: {
          nodeId,
          kind: 'error',
          errorName: 'SubflowRejected',
          errorMessage:
            payload?.reason ??
            `subflow "${config.flowId}" had an unhandled gate rejection`,
        },
      };
    }

    const innerOutputOut = typeof result.output === 'string' ? result.output : '';
    const innerChangedFiles = Array.isArray(result.changedFiles) ? result.changedFiles : [];
    // steering deltas: only entries the inner ADDED (not the ones we
    // passed down). Compare lengths since the inner's reducer
    // appends — slice off the prefix we sent in.
    const innerSteeringFinal = Array.isArray(result.steering) ? (result.steering as string[]) : [];
    const newSteering = innerSteeringFinal.slice(state.steering.length);

    return {
      output: innerOutputOut,
      lastExit: { nodeId, kind: 'success' },
      ...(innerChangedFiles.length > 0 ? { changedFiles: innerChangedFiles } : {}),
      ...(newSteering.length > 0 ? { steering: newSteering } : {}),
    };
  };
}

/**
 * Resolve the `SubflowConfig.input` map against parent state and
 * return a single string suitable for the inner's initial `output`.
 *
 * Each value is either a literal (passed through) or an Expression
 * (jsonpath/literal — `js` throws as elsewhere). The whole map is
 * JSON-stringified so the inner sees a structured-but-string input;
 * inner steps that need fields can use `transform` with jsonpath
 * against `$.output` parsed as JSON.
 *
 * Why not pass the resolved object directly? Because the runtime
 * state's `output` channel is a string. Keeping types narrow at the
 * channel boundary saves a polymorphism story everywhere.
 */
function stringifyInputOverride(
  input: Record<string, unknown>,
  state: FlowStateT,
): string {
  const resolved: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    resolved[k] = isExpression(v) ? evalExpressionToValue(v, state) : v;
  }
  return JSON.stringify(resolved);
}

function isExpression(v: unknown): v is Expression {
  if (!v || typeof v !== 'object') return false;
  const k = (v as { kind?: unknown }).kind;
  return k === 'literal' || k === 'jsonpath' || k === 'js';
}

function evalExpressionToValue(expr: Expression, state: FlowStateT): unknown {
  if (expr.kind === 'literal') return expr.value;
  if (expr.kind === 'jsonpath') return resolveJsonPath(expr.path, state);
  throw new Error('"js" expression kind is not yet supported in subflow input');
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

/**
 * Dependencies needed to compile an inner subflow target. Mirrors the
 * agent-free subset of RunJobDeps from orchestrator.ts — kept narrow
 * so this helper doesn't pin agent / binding concerns. The
 * orchestrator passes a projection of its own RunJobDeps when
 * invoking.
 */
export interface SubflowCompileDeps {
  flowResolver?: FlowResolver;
  toolResolver?: import('./catalog.ts').ToolResolver;
  broker?: import('@ecruz165/agent-auth').CredentialBroker;
  fetchFn?: typeof fetch;
  mcpInvokeFn?: import('./tool-executor.ts').ToolExecutorDeps['mcpInvokeFn'];
}

/**
 * Compile an inner subflow target. Recursively compiles any further-
 * nested subflows. Builds per-node executors for the kinds inner
 * flows are allowed to contain (tool, gate, transform, trigger, and
 * subflow). Agent / approval / suspend are validated out earlier by
 * `validateSubflowGraph`.
 *
 * Returns a CompiledFlowGraph whose `invoke()` runs the inner flow
 * with its own MemorySaver checkpointer (one per inner). For v1
 * subflows can't pause, so checkpoint state is essentially write-
 * only; when interrupt propagation lands, share the parent's
 * checkpointer here.
 *
 * Tool executors are constructed via a late-bound import from
 * `./tool-executor.ts` to avoid a static module cycle (subflow ↔
 * tool ↔ flow-graph). The dynamic require lands inside the function
 * body so it executes per-call after the modules have settled.
 */
export function compileNonAgentFlow(
  flow: FlowDef,
  deps: SubflowCompileDeps,
): CompiledFlowGraph {
  // Late require: avoids the static cycle that would arise if we
  // imported makeToolExecutor at module scope (tool-executor →
  // catalog → flow-graph; subflow-executor → tool-executor would
  // close it). This stays within harness-core; no runtime overhead
  // beyond the first cache.
  const { makeToolExecutor } = require('./tool-executor.ts') as typeof import(
    './tool-executor.ts'
  );

  const innerByNodeId = deps.flowResolver
    ? validateSubflowGraph(flow, deps.flowResolver)
    : new Map<string, FlowDef>();

  const nestedGraphs = new Map<string, CompiledFlowGraph>();
  for (const [nodeId, innerFlow] of innerByNodeId) {
    nestedGraphs.set(nodeId, compileNonAgentFlow(innerFlow, deps));
  }

  const executors = new Map<string, NodeExecutor>();
  for (const node of flow.nodes) {
    if (node.kind === 'tool') {
      if (!deps.toolResolver) {
        const id = node.id;
        executors.set(id, async () => ({
          lastExit: {
            nodeId: id,
            kind: 'error',
            errorName: 'UnconfiguredToolResolver',
            errorMessage: `tool node "${id}" inside subflow cannot dispatch — no toolResolver`,
          },
        }));
        continue;
      }
      executors.set(
        node.id,
        makeToolExecutor(node, {
          toolResolver: deps.toolResolver,
          broker: deps.broker,
          fetchFn: deps.fetchFn,
          mcpInvokeFn: deps.mcpInvokeFn,
        }),
      );
    } else if (node.kind === 'subflow') {
      const innerGraph = nestedGraphs.get(node.id);
      if (!innerGraph) {
        // Defensive — validateSubflowGraph above must have produced
        // an entry for every subflow node it walked. If not, fail
        // loud rather than silently no-op the nested step.
        const id = node.id;
        executors.set(id, async () => ({
          lastExit: {
            nodeId: id,
            kind: 'error',
            errorName: 'SubflowMissing',
            errorMessage: `nested subflow "${id}" was not pre-compiled — programming error`,
          },
        }));
        continue;
      }
      executors.set(node.id, makeSubflowExecutor(node, innerGraph));
    }
    // gate / transform / trigger handled by flow-graph builtins.
    // script throws via flow-graph default. agent BANNED in inner
    // flows — validator catches it before here.
  }

  return compileFlow({ flow, executors }) as CompiledFlowGraph;
}

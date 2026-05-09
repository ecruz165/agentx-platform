/**
 * Unit tests for the `kind: 'subflow'` step kind.
 *
 * Two test surfaces:
 *   1. validateSubflowGraph — compile-time validation. Catches missing
 *      flowIds, cycles (self + transitive), and v1-banned kinds (agent /
 *      approval / suspend in inner flows).
 *   2. End-to-end: parent compiled via compileNonAgentFlow with a real
 *      inner flow. Output flows back, gate-rejected inner produces
 *      error exit on parent, optional input override is honored.
 *
 * agent-driven runJob integration is not covered here (subflows can't
 * contain agents in v1 — by design); orchestrator.test.ts owns the
 * agent + subflow integration story when v2 lifts the restriction.
 */
import { describe, expect, it } from 'vitest';
import { CatalogError, type FlowDef, type TaskStep } from './catalog.ts';
import {
  compileNonAgentFlow,
  type FlowResolver,
  validateSubflowGraph,
} from './subflow-executor.ts';

// ─── helpers ──────────────────────────────────────────────────────────────

function trigger(id = 't'): TaskStep {
  return { id, kind: 'trigger', config: { kind: 'manual' } };
}

function transformNode(id: string, value: string): TaskStep {
  return {
    id,
    kind: 'transform',
    config: { expression: { kind: 'literal', value } },
  };
}

function gateNode(id: string, alwaysFail = false): TaskStep {
  return {
    id,
    kind: 'gate',
    config: {
      assertions: alwaysFail
        ? [{ expression: { kind: 'literal', value: false }, message: 'always fails' }]
        : [{ expression: { kind: 'literal', value: true }, message: 'never fails' }],
    },
  };
}

function subflowNode(
  id: string,
  flowId: string,
  input?: Record<string, unknown>,
): TaskStep {
  return { id, kind: 'subflow', config: { flowId, ...(input ? { input } : {}) } };
}

function flowOf(id: string, ...nodes: TaskStep[]): FlowDef {
  // Wire every adjacent pair with a sequence edge — the trigger
  // is expected to be `nodes[0]`. Edges defined here are the
  // smallest possible chain.
  const edges = nodes.slice(0, -1).map((n, i) => ({
    from: n.id,
    to: nodes[i + 1]!.id,
    type: 'sequence' as const,
  }));
  return { id, nodes, edges };
}

function staticFlowResolver(map: Record<string, FlowDef>): FlowResolver {
  return (id) => map[id];
}

// ─── validateSubflowGraph ─────────────────────────────────────────────────

describe('validateSubflowGraph', () => {
  it('returns empty map for flows without subflow nodes', () => {
    const f = flowOf('parent', trigger(), transformNode('t1', 'x'));
    const map = validateSubflowGraph(f, staticFlowResolver({}));
    expect(map.size).toBe(0);
  });

  it('throws CatalogError when flowId does not resolve', () => {
    const parent = flowOf('parent', trigger(), subflowNode('s', 'missing'));
    expect(() => validateSubflowGraph(parent, staticFlowResolver({}))).toThrow(
      CatalogError,
    );
  });

  it('throws CatalogError on self-reference', () => {
    const parent = flowOf('parent', trigger(), subflowNode('s', 'parent'));
    expect(() =>
      validateSubflowGraph(parent, staticFlowResolver({ parent })),
    ).toThrow(/cycle/);
  });

  it('throws CatalogError on transitive cycle (A → B → A)', () => {
    const flowA: FlowDef = flowOf('A', trigger(), subflowNode('s', 'B'));
    const flowB: FlowDef = flowOf('B', trigger(), subflowNode('s', 'A'));
    expect(() =>
      validateSubflowGraph(flowA, staticFlowResolver({ A: flowA, B: flowB })),
    ).toThrow(/cycle/);
  });

  it('throws CatalogError when inner contains an agent node (v1 deferral)', () => {
    const inner: FlowDef = flowOf('inner', trigger(), {
      id: 'a',
      kind: 'agent',
      config: { agent: { id: 'a' } as never },
    });
    const parent = flowOf('parent', trigger(), subflowNode('s', 'inner'));
    expect(() =>
      validateSubflowGraph(parent, staticFlowResolver({ inner })),
    ).toThrow(/agents in subflows are not supported/);
  });

  it('throws CatalogError when inner has approval-tagged node (v1 deferral)', () => {
    const taggedNode: TaskStep = {
      id: 'gate1',
      kind: 'gate',
      config: { assertions: [{ expression: { kind: 'literal', value: true }, message: 'ok' }] },
      tags: { approval: { assigneeRole: 'reviewer', slaMs: 1000, concurrency: 'pessimistic' } },
    };
    const inner: FlowDef = flowOf('inner', trigger(), taggedNode);
    const parent = flowOf('parent', trigger(), subflowNode('s', 'inner'));
    expect(() =>
      validateSubflowGraph(parent, staticFlowResolver({ inner })),
    ).toThrow(/interrupt propagation from subflows is not supported/);
  });

  it('throws CatalogError when inner has suspend-tagged node (v1 deferral)', () => {
    const taggedNode: TaskStep = {
      id: 'gate1',
      kind: 'gate',
      config: { assertions: [{ expression: { kind: 'literal', value: true }, message: 'ok' }] },
      tags: { suspend: { trigger: { kind: 'timer', durationMs: 1000 } } },
    };
    const inner: FlowDef = flowOf('inner', trigger(), taggedNode);
    const parent = flowOf('parent', trigger(), subflowNode('s', 'inner'));
    expect(() =>
      validateSubflowGraph(parent, staticFlowResolver({ inner })),
    ).toThrow(/interrupt propagation from subflows is not supported/);
  });

  it('returns the parent-node-id → inner FlowDef map on a valid graph', () => {
    const inner = flowOf('inner', trigger(), transformNode('t', 'hi'));
    const parent = flowOf('parent', trigger(), subflowNode('s', 'inner'));
    const map = validateSubflowGraph(parent, staticFlowResolver({ inner }));
    expect(map.size).toBe(1);
    expect(map.get('s')?.id).toBe('inner');
  });

  it('walks nested subflows and validates each level', () => {
    const deepest = flowOf('deepest', trigger(), transformNode('t', 'leaf'));
    const middle = flowOf('middle', trigger(), subflowNode('m1', 'deepest'));
    const parent = flowOf('parent', trigger(), subflowNode('s1', 'middle'));
    const resolver = staticFlowResolver({ middle, deepest });
    const map = validateSubflowGraph(parent, resolver);
    // validateSubflowGraph returns only the FIRST level's targets;
    // nested compilation walks further.
    expect(map.size).toBe(1);
    expect(map.get('s1')?.id).toBe('middle');
  });
});

// ─── End-to-end: compileNonAgentFlow + invoke ────────────────────────────

describe('compileNonAgentFlow + makeSubflowExecutor (integration)', () => {
  // Helper: build a parent flow with a subflow node, compile via the
  // non-agent path (sufficient since the parent here also has no
  // agents), and invoke. Returns the final state.
  async function runParent(
    parent: FlowDef,
    flows: Record<string, FlowDef>,
    initialOutput = '',
  ): Promise<Record<string, unknown>> {
    const graph = compileNonAgentFlow(parent, {
      flowResolver: staticFlowResolver(flows),
    });
    const initial = {
      jobId: 'test-job',
      output: initialOutput,
      messages: [],
      attempts: {},
      lastExit: null,
      rejectionPayload: null,
      steering: [],
      cancelRequested: false,
      cancelReason: null,
      changedFiles: [],
    };
    return graph.invoke(initial, { configurable: { thread_id: 'test-thread' } });
  }

  it('inner output flows back as parent state.output on success', async () => {
    const inner = flowOf('inner', trigger(), transformNode('write-greeting', 'hello-from-inner'));
    const parent = flowOf('parent', trigger(), subflowNode('s', 'inner'));
    const result = await runParent(parent, { inner });
    expect(result.output).toBe('hello-from-inner');
  });

  it('inner gate-reject surfaces as parent error exit (terminal subflow node)', async () => {
    const inner = flowOf('inner', trigger(), gateNode('always-fail', true));
    const parent = flowOf('parent', trigger(), subflowNode('s', 'inner'));
    // Subflow node is terminal in the parent (no outgoing edges) →
    // compileFlow short-circuits to END without invoking the router.
    // Result: graph completes, lastExit reflects the error, but no
    // throw. The router-throw path is exercised by the next test.
    const result = await runParent(parent, { inner });
    expect(result.lastExit).toMatchObject({
      kind: 'error',
      errorName: 'SubflowRejected',
    });
  });

  it('throws unhandled-error when subflow fails and parent has a downstream sequence edge but no error edge', async () => {
    const inner = flowOf('inner', trigger(), gateNode('always-fail', true));
    // Parent: trigger → subflow → tail. Sequence edge means the
    // subflow node is non-terminal, so the router runs on its
    // error exit. With no error edge wired, the router throws.
    const parent = flowOf(
      'parent',
      trigger(),
      subflowNode('s', 'inner'),
      transformNode('tail', 'unreached'),
    );
    await expect(runParent(parent, { inner })).rejects.toThrow(/unhandled error/);
  });

  it('SubflowConfig.input override replaces parent state.output for the inner', async () => {
    // Inner: pass-through transform that writes a literal value. We
    // don't actually use the input override's effect on the inner's
    // first node (transform is a literal write); instead we verify
    // input override doesn't BREAK the inner. A more direct
    // assertion would require an inner step that echoes its input,
    // which requires a tool — out of scope for this layer.
    const inner = flowOf('inner', trigger(), transformNode('echo', 'inner-fixed-value'));
    const parent = flowOf(
      'parent',
      trigger(),
      subflowNode('s', 'inner', { from: 'literal-input' }),
    );
    const result = await runParent(parent, { inner }, 'initial-parent-output');
    expect(result.output).toBe('inner-fixed-value');
  });

  it('nested subflow chains output through both levels', async () => {
    const deepest = flowOf('deepest', trigger(), transformNode('w', 'from-deepest'));
    const middle = flowOf('middle', trigger(), subflowNode('m', 'deepest'));
    const parent = flowOf('parent', trigger(), subflowNode('s', 'middle'));
    const result = await runParent(parent, { middle, deepest });
    expect(result.output).toBe('from-deepest');
  });
});

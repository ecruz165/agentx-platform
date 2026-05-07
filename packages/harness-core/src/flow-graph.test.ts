/**
 * Unit tests for the FlowDef → LangGraph compiler.
 *
 * These tests exercise the compiler in isolation — no adapters, no auth,
 * no JobRecord, no JobBus. Per-node behavior is faked via the executor
 * map so we can pin edge-routing semantics without dragging in the full
 * agent runtime.
 *
 * The runJob-level integration is covered by orchestrator.test.ts; the
 * focus here is: given a FlowDef shape, does the compiler produce the
 * graph you'd expect, and does each edge kind dispatch correctly?
 */

import { describe, expect, it } from 'vitest';
import type { Edge, FlowDef, TaskStep } from './catalog.ts';
import {
  buildRouter,
  compileFlow,
  evalExpression,
  type FlowStateT,
  linearFlowFromAgents,
  type NodeExecutor,
} from './flow-graph.ts';

// ─── helpers ──────────────────────────────────────────────────────────────

function trigger(id = 't'): TaskStep {
  return { id, kind: 'trigger', config: { kind: 'manual' } };
}

function agentNode(id: string): TaskStep {
  // Tests don't exercise AgentDef body — minimal placeholder is fine.
  return {
    id,
    kind: 'agent',
    config: { agent: { id } as never },
  };
}

/** Node that records being called and returns a state delta. */
function makeRecorder(calls: string[], id: string, delta: Partial<FlowStateT> = {}): NodeExecutor {
  return async () => {
    calls.push(id);
    return { lastExit: { nodeId: id, kind: 'success' }, ...delta };
  };
}

function makeError(id: string, message = 'boom'): NodeExecutor {
  return async () => ({
    lastExit: { nodeId: id, kind: 'error', errorName: 'Error', errorMessage: message },
  });
}

function makeReject(calls: string[], id: string, attemptKey: string): NodeExecutor {
  return async (state) => {
    calls.push(id);
    const attempts = state.attempts[attemptKey] ?? 0;
    return {
      attempts: { [attemptKey]: attempts + 1 },
      lastExit: { nodeId: id, kind: 'reject' },
      rejectionPayload: { reason: 'no good', attempt: attempts + 1 },
    };
  };
}

const initialState: FlowStateT = {
  jobId: 'test',
  output: '',
  messages: [],
  attempts: {},
  lastExit: null,
  rejectionPayload: null,
};

// ─── compileFlow: topology ────────────────────────────────────────────────

describe('compileFlow — topology', () => {
  it('routes START → trigger → agent → END for a 2-node linear flow', async () => {
    const calls: string[] = [];
    const flow: FlowDef = {
      id: 'linear',
      nodes: [trigger('t'), agentNode('a')],
      edges: [{ from: 't', to: 'a', type: 'sequence' }],
    };
    const executors = new Map<string, NodeExecutor>([
      ['a', makeRecorder(calls, 'a', { output: 'done' })],
    ]);

    const graph = compileFlow({ flow, executors });
    const result = await graph.invoke(initialState);

    expect(calls).toEqual(['a']);
    expect(result.output).toBe('done');
  });

  it('throws at compile time when no trigger node is present', () => {
    const flow: FlowDef = {
      id: 'no-trigger',
      nodes: [agentNode('a')],
      edges: [],
    };
    expect(() => compileFlow({ flow, executors: new Map() })).toThrow(/no trigger node/);
  });

  it('terminates at nodes with no outgoing edges', async () => {
    const calls: string[] = [];
    const flow: FlowDef = {
      id: 'two-step',
      nodes: [trigger('t'), agentNode('a'), agentNode('b')],
      edges: [
        { from: 't', to: 'a', type: 'sequence' },
        { from: 'a', to: 'b', type: 'sequence' },
        // b has no outgoing → END
      ],
    };
    const executors = new Map<string, NodeExecutor>([
      ['a', makeRecorder(calls, 'a')],
      ['b', makeRecorder(calls, 'b')],
    ]);
    const graph = compileFlow({ flow, executors });
    await graph.invoke(initialState);
    expect(calls).toEqual(['a', 'b']);
  });

  it('threads output across sequence edges', async () => {
    const flow: FlowDef = {
      id: 'thread',
      nodes: [trigger('t'), agentNode('a'), agentNode('b')],
      edges: [
        { from: 't', to: 'a', type: 'sequence' },
        { from: 'a', to: 'b', type: 'sequence' },
      ],
    };
    const executors = new Map<string, NodeExecutor>([
      [
        'a',
        async () => ({
          output: 'from-a',
          lastExit: { nodeId: 'a', kind: 'success' },
        }),
      ],
      [
        'b',
        async (state) => ({
          output: `${state.output}+from-b`,
          lastExit: { nodeId: 'b', kind: 'success' },
        }),
      ],
    ]);
    const graph = compileFlow({ flow, executors });
    const result = await graph.invoke(initialState);
    expect(result.output).toBe('from-a+from-b');
  });
});

// ─── conditional edges ───────────────────────────────────────────────────

describe('compileFlow — conditional edges', () => {
  it('routes to the first conditional whose predicate matches', async () => {
    const calls: string[] = [];
    const flow: FlowDef = {
      id: 'cond',
      nodes: [trigger('t'), agentNode('a'), agentNode('b'), agentNode('c')],
      edges: [
        { from: 't', to: 'a', type: 'sequence' },
        {
          from: 'a',
          to: 'b',
          type: 'conditional',
          condition: { kind: 'jsonpath', path: '$.output' },
        },
        {
          from: 'a',
          to: 'c',
          type: 'conditional',
          condition: { kind: 'literal', value: true },
        },
      ],
    };
    const executors = new Map<string, NodeExecutor>([
      [
        'a',
        async () => ({
          output: 'has-value',
          lastExit: { nodeId: 'a', kind: 'success' },
        }),
      ],
      ['b', makeRecorder(calls, 'b')],
      ['c', makeRecorder(calls, 'c')],
    ]);
    const graph = compileFlow({ flow, executors });
    await graph.invoke(initialState);
    // Output is truthy → first conditional matches → b runs, c does not.
    expect(calls).toEqual(['b']);
  });

  it('falls through to sequence edge when no conditional matches', async () => {
    const calls: string[] = [];
    const flow: FlowDef = {
      id: 'cond-fallthrough',
      nodes: [trigger('t'), agentNode('a'), agentNode('b'), agentNode('c')],
      edges: [
        { from: 't', to: 'a', type: 'sequence' },
        {
          from: 'a',
          to: 'b',
          type: 'conditional',
          condition: { kind: 'literal', value: false },
        },
        { from: 'a', to: 'c', type: 'sequence' },
      ],
    };
    const executors = new Map<string, NodeExecutor>([
      ['a', makeRecorder(calls, 'a')],
      ['b', makeRecorder(calls, 'b')],
      ['c', makeRecorder(calls, 'c')],
    ]);
    const graph = compileFlow({ flow, executors });
    await graph.invoke(initialState);
    expect(calls).toEqual(['a', 'c']);
  });
});

// ─── error edges ──────────────────────────────────────────────────────────

describe('compileFlow — error edges', () => {
  it('routes to error target when an executor reports an error exit', async () => {
    const calls: string[] = [];
    const flow: FlowDef = {
      id: 'err',
      nodes: [trigger('t'), agentNode('a'), agentNode('b'), agentNode('handler')],
      edges: [
        { from: 't', to: 'a', type: 'sequence' },
        { from: 'a', to: 'b', type: 'sequence' },
        { from: 'a', to: 'handler', type: 'error' },
      ],
    };
    const executors = new Map<string, NodeExecutor>([
      ['a', makeError('a')],
      ['b', makeRecorder(calls, 'b')],
      ['handler', makeRecorder(calls, 'handler')],
    ]);
    const graph = compileFlow({ flow, executors });
    await graph.invoke(initialState);
    // a errored, error edge → handler. b never runs.
    expect(calls).toEqual(['handler']);
  });

  it('terminates without running successor nodes when an error exit has no error edge', async () => {
    // LangGraph's behavior on router throws is graph-internal — for the
    // runJob caller the contract is: no further node executes. Verify
    // that, rather than asserting on the throw shape (which is an
    // implementation detail of the underlying graph runtime).
    const calls: string[] = [];
    const flow: FlowDef = {
      id: 'err-uncaught',
      nodes: [trigger('t'), agentNode('a'), agentNode('b')],
      edges: [
        { from: 't', to: 'a', type: 'sequence' },
        { from: 'a', to: 'b', type: 'sequence' },
      ],
    };
    const executors = new Map<string, NodeExecutor>([
      ['a', makeError('a', 'kaboom')],
      ['b', makeRecorder(calls, 'b')],
    ]);
    const graph = compileFlow({ flow, executors });

    // Invoke may resolve or reject depending on LangGraph internals;
    // either way, b must NOT have run.
    try {
      await graph.invoke(initialState);
    } catch {
      // Expected on some runtimes.
    }
    expect(calls).not.toContain('b');
  });
});

// ─── reject edges ─────────────────────────────────────────────────────────

describe('compileFlow — reject edges (cycles)', () => {
  it('cycles back via reject edge until maxAttempts is reached', async () => {
    const calls: string[] = [];
    const flow: FlowDef = {
      id: 'reject-cycle',
      nodes: [trigger('t'), agentNode('worker'), agentNode('gate')],
      edges: [
        { from: 't', to: 'worker', type: 'sequence' },
        { from: 'worker', to: 'gate', type: 'sequence' },
        // gate rejects → worker (cycle), max 3 attempts.
        { from: 'gate', to: 'worker', type: 'reject', maxAttempts: 3 },
      ],
    };
    const executors = new Map<string, NodeExecutor>([
      [
        'worker',
        async () => {
          calls.push('worker');
          return { lastExit: { nodeId: 'worker', kind: 'success' } };
        },
      ],
      [
        'gate',
        async (state) => {
          calls.push('gate');
          const attempts = state.attempts.gate ?? 0;
          return {
            attempts: { gate: attempts + 1 },
            lastExit: { nodeId: 'gate', kind: 'reject' },
          };
        },
      ],
    ]);
    const graph = compileFlow({ flow, executors });

    // Reject limit blows up — but worker + gate must have run 3x each.
    await expect(graph.invoke(initialState)).rejects.toThrow(/reject limit/);
    expect(calls.filter((c) => c === 'worker').length).toBe(3);
    expect(calls.filter((c) => c === 'gate').length).toBe(3);
  });

  it('escalates to the configured target when maxAttempts is exceeded with onMaxAttempts.escalate', async () => {
    const calls: string[] = [];
    const flow: FlowDef = {
      id: 'reject-escalate',
      nodes: [trigger('t'), agentNode('worker'), agentNode('gate'), agentNode('escalation')],
      edges: [
        { from: 't', to: 'worker', type: 'sequence' },
        { from: 'worker', to: 'gate', type: 'sequence' },
        {
          from: 'gate',
          to: 'worker',
          type: 'reject',
          maxAttempts: 2,
          onMaxAttempts: { kind: 'escalate', to: 'escalation' },
        },
      ],
    };
    const executors = new Map<string, NodeExecutor>([
      ['worker', makeRecorder(calls, 'worker')],
      ['gate', makeReject(calls, 'gate', 'gate')],
      ['escalation', makeRecorder(calls, 'escalation')],
    ]);
    const graph = compileFlow({ flow, executors });
    await graph.invoke(initialState);
    expect(calls.filter((c) => c === 'worker').length).toBe(2);
    expect(calls.filter((c) => c === 'gate').length).toBe(2);
    expect(calls).toContain('escalation');
  });
});

// ─── fallback edges ──────────────────────────────────────────────────────

describe('compileFlow — fallback edges', () => {
  it('uses the fallback edge when no sequence or conditional fires', async () => {
    const calls: string[] = [];
    const flow: FlowDef = {
      id: 'fb',
      nodes: [trigger('t'), agentNode('a'), agentNode('catchall')],
      edges: [
        { from: 't', to: 'a', type: 'sequence' },
        { from: 'a', to: 'catchall', type: 'fallback' },
      ],
    };
    const executors = new Map<string, NodeExecutor>([
      ['a', makeRecorder(calls, 'a')],
      ['catchall', makeRecorder(calls, 'catchall')],
    ]);
    const graph = compileFlow({ flow, executors });
    await graph.invoke(initialState);
    expect(calls).toEqual(['a', 'catchall']);
  });

  it('prefers sequence over fallback when both exist', async () => {
    const calls: string[] = [];
    const flow: FlowDef = {
      id: 'fb-vs-seq',
      nodes: [trigger('t'), agentNode('a'), agentNode('next'), agentNode('catchall')],
      edges: [
        { from: 't', to: 'a', type: 'sequence' },
        { from: 'a', to: 'next', type: 'sequence' },
        { from: 'a', to: 'catchall', type: 'fallback' },
      ],
    };
    const executors = new Map<string, NodeExecutor>([
      ['a', makeRecorder(calls, 'a')],
      ['next', makeRecorder(calls, 'next')],
      ['catchall', makeRecorder(calls, 'catchall')],
    ]);
    const graph = compileFlow({ flow, executors });
    await graph.invoke(initialState);
    expect(calls).toEqual(['a', 'next']);
    expect(calls).not.toContain('catchall');
  });
});

// ─── buildRouter (in isolation) ───────────────────────────────────────────

describe('buildRouter', () => {
  function state(overrides: Partial<FlowStateT> = {}): FlowStateT {
    return { ...initialState, ...overrides };
  }

  it('returns sequence target by default', () => {
    const router = buildRouter('a', [{ from: 'a', to: 'b', type: 'sequence' }]);
    expect(router(state({ lastExit: { nodeId: 'a', kind: 'success' } }))).toBe('b');
  });

  it('returns the literal-true conditional target', () => {
    const edges: Edge[] = [
      {
        from: 'a',
        to: 'b',
        type: 'conditional',
        condition: { kind: 'literal', value: true },
      },
      { from: 'a', to: 'c', type: 'sequence' },
    ];
    const router = buildRouter('a', edges);
    expect(router(state({ lastExit: { nodeId: 'a', kind: 'success' } }))).toBe('b');
  });

  it('returns sequence when literal-false conditional skips', () => {
    const edges: Edge[] = [
      {
        from: 'a',
        to: 'b',
        type: 'conditional',
        condition: { kind: 'literal', value: false },
      },
      { from: 'a', to: 'c', type: 'sequence' },
    ];
    const router = buildRouter('a', edges);
    expect(router(state({ lastExit: { nodeId: 'a', kind: 'success' } }))).toBe('c');
  });

  it('routes to error target on error exit', () => {
    const edges: Edge[] = [
      { from: 'a', to: 'b', type: 'sequence' },
      { from: 'a', to: 'h', type: 'error' },
    ];
    const router = buildRouter('a', edges);
    expect(
      router(
        state({
          lastExit: { nodeId: 'a', kind: 'error', errorMessage: 'x' },
        }),
      ),
    ).toBe('h');
  });

  it('throws on error exit with no error edge', () => {
    const router = buildRouter('a', [{ from: 'a', to: 'b', type: 'sequence' }]);
    expect(() =>
      router(state({ lastExit: { nodeId: 'a', kind: 'error', errorMessage: 'x' } })),
    ).toThrow(/unhandled error/);
  });

  it('routes reject to its target while attempts < max', () => {
    const edges: Edge[] = [{ from: 'a', to: 'b', type: 'reject', maxAttempts: 3 }];
    const router = buildRouter('a', edges);
    expect(
      router(
        state({
          lastExit: { nodeId: 'a', kind: 'reject' },
          attempts: { a: 1 },
        }),
      ),
    ).toBe('b');
  });

  it('throws when reject attempts exceed maxAttempts and onMaxAttempts is unset', () => {
    const edges: Edge[] = [{ from: 'a', to: 'b', type: 'reject', maxAttempts: 2 }];
    const router = buildRouter('a', edges);
    expect(() =>
      router(
        state({
          lastExit: { nodeId: 'a', kind: 'reject' },
          attempts: { a: 2 },
        }),
      ),
    ).toThrow(/reject limit/);
  });

  it('escalates when reject exceeds maxAttempts and onMaxAttempts.kind === escalate', () => {
    const edges: Edge[] = [
      {
        from: 'a',
        to: 'b',
        type: 'reject',
        maxAttempts: 2,
        onMaxAttempts: { kind: 'escalate', to: 'esc' },
      },
    ];
    const router = buildRouter('a', edges);
    expect(
      router(
        state({
          lastExit: { nodeId: 'a', kind: 'reject' },
          attempts: { a: 2 },
        }),
      ),
    ).toBe('esc');
  });
});

// ─── evalExpression ───────────────────────────────────────────────────────

describe('evalExpression', () => {
  const s: FlowStateT = {
    jobId: 'j',
    output: 'has-value',
    messages: [],
    attempts: { node1: 2 },
    lastExit: null,
    rejectionPayload: null,
  };

  it('handles literal true', () => {
    expect(evalExpression({ kind: 'literal', value: true }, s)).toBe(true);
  });

  it('handles literal false', () => {
    expect(evalExpression({ kind: 'literal', value: false }, s)).toBe(false);
  });

  it('handles literal truthy non-boolean', () => {
    expect(evalExpression({ kind: 'literal', value: 'yes' }, s)).toBe(true);
    expect(evalExpression({ kind: 'literal', value: 0 }, s)).toBe(false);
  });

  it('resolves jsonpath $.field', () => {
    expect(evalExpression({ kind: 'jsonpath', path: '$.output' }, s)).toBe(true);
    expect(evalExpression({ kind: 'jsonpath', path: '$.output' }, { ...s, output: '' })).toBe(
      false,
    );
  });

  it('resolves jsonpath $.field.subfield', () => {
    expect(evalExpression({ kind: 'jsonpath', path: '$.attempts.node1' }, s)).toBe(true);
    expect(evalExpression({ kind: 'jsonpath', path: '$.attempts.missing' }, s)).toBe(false);
  });

  it('returns false for malformed jsonpath', () => {
    expect(evalExpression({ kind: 'jsonpath', path: 'output' }, s)).toBe(false);
  });

  it('throws on js kind (no sandbox wired)', () => {
    expect(() => evalExpression({ kind: 'js', expression: 'state.output' }, s)).toThrow(
      /not yet supported/,
    );
  });
});

// ─── linearFlowFromAgents ────────────────────────────────────────────────

describe('linearFlowFromAgents', () => {
  it('produces a trigger + agent chain with sequence edges', () => {
    const flow = linearFlowFromAgents('demo', [{ id: 'a' }, { id: 'b' }]);
    expect(flow.id).toBe('demo');
    expect(flow.nodes).toHaveLength(3);
    expect(flow.nodes[0]?.kind).toBe('trigger');
    expect(flow.nodes[1]?.id).toBe('a');
    expect(flow.nodes[2]?.id).toBe('b');
    expect(flow.edges).toEqual([
      { from: '__trigger', to: 'a', type: 'sequence' },
      { from: 'a', to: 'b', type: 'sequence' },
    ]);
  });

  it('filters out coordinator + checkout-coordinator agents', () => {
    const flow = linearFlowFromAgents('demo', [
      { id: 'coordinator' },
      { id: 'a' },
      { id: 'checkout-coordinator' },
      { id: 'b' },
    ]);
    expect(flow.nodes.map((n) => n.id)).toEqual(['__trigger', 'a', 'b']);
    expect(flow.edges).toEqual([
      { from: '__trigger', to: 'a', type: 'sequence' },
      { from: 'a', to: 'b', type: 'sequence' },
    ]);
  });

  it('handles the all-coordinators case (only trigger, no edges)', () => {
    const flow = linearFlowFromAgents('demo', [
      { id: 'coordinator' },
      { id: 'checkout-coordinator' },
    ]);
    expect(flow.nodes).toHaveLength(1);
    expect(flow.nodes[0]?.kind).toBe('trigger');
    expect(flow.edges).toEqual([]);
  });
});

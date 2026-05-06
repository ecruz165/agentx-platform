/**
 * LangGraphAdapter tests.
 *
 * Uses real `@langchain/langgraph` graphs (not mocks) — the surface is
 * thin enough that the unit-test boundary IS the graph's invoke()
 * behavior. Graphs are no-LLM so tests run offline. Each graph is a
 * pure data transformation: input goes in, deterministic output comes
 * out.
 *
 * Uses LangGraph 1.x `Annotation` API — the newer typed channels
 * pattern preferred over the legacy `{ value: null }` reducer shorthand.
 *
 * Coverage:
 *   - invoke() returns the responseKey field as string
 *   - emits request + response events with the expected shape
 *   - graphLabel surfaces in the request event's model field
 *   - error events fire on graph throw
 *   - buildInitialState override flows through
 */

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import type { AdapterEvent } from './events.ts';
import { type CompiledGraph, LangGraphAdapter } from './langgraph-adapter.ts';

/** Echo graph: { input: string } → { output: 'echo: <input>' }. */
function echoGraph(): CompiledGraph {
  const State = Annotation.Root({
    input: Annotation<string>,
    output: Annotation<string>,
  });
  const builder = new StateGraph(State)
    .addNode('echo', (state) => ({ output: `echo: ${state.input}` }))
    .addEdge(START, 'echo')
    .addEdge('echo', END);
  return builder.compile() as unknown as CompiledGraph;
}

/** Two-step: capitalize then prefix. Multi-node flow visible to the
 *  adapter only as final state. */
function twoStepGraph(): CompiledGraph {
  const State = Annotation.Root({
    input: Annotation<string>,
    capped: Annotation<string>,
    output: Annotation<string>,
  });
  const builder = new StateGraph(State)
    .addNode('cap', (state) => ({ capped: state.input.toUpperCase() }))
    .addNode('prefix', (state) => ({ output: `>> ${state.capped}` }))
    .addEdge(START, 'cap')
    .addEdge('cap', 'prefix')
    .addEdge('prefix', END);
  return builder.compile() as unknown as CompiledGraph;
}

/** Graph that throws — exercises error path. */
function throwingGraph(): CompiledGraph {
  const State = Annotation.Root({
    input: Annotation<string>,
    output: Annotation<string>,
  });
  const builder = new StateGraph(State)
    .addNode('fail', () => {
      throw new Error('intentional graph failure');
    })
    .addEdge(START, 'fail')
    .addEdge('fail', END);
  return builder.compile() as unknown as CompiledGraph;
}

describe('LangGraphAdapter', () => {
  it('runs a simple graph end-to-end and returns the output field', async () => {
    const adapter = new LangGraphAdapter({ graph: echoGraph() });
    const result = await adapter.invoke({ user: 'hello' });
    expect(result).toBe('echo: hello');
  });

  it('emits request then response events around the graph invocation', async () => {
    const events: AdapterEvent[] = [];
    const adapter = new LangGraphAdapter({ graph: echoGraph() });
    adapter.events.subscribe((e) => events.push(e));
    await adapter.invoke({ system: 'be brief', user: 'hi' });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: 'request',
      system: 'be brief',
      user: 'hi',
      model: 'langgraph',
    });
    expect(events[1]).toMatchObject({
      kind: 'response',
      text: 'echo: hi',
    });
  });

  it('surfaces graphLabel in the request event so observability can distinguish graphs', async () => {
    const events: AdapterEvent[] = [];
    const adapter = new LangGraphAdapter({
      graph: echoGraph(),
      graphLabel: 'coordinator-routing',
    });
    adapter.events.subscribe((e) => events.push(e));
    await adapter.invoke({ user: 'go' });
    expect(events[0]).toMatchObject({ kind: 'request', model: 'coordinator-routing' });
  });

  it('threads multi-node graphs to a final response', async () => {
    const adapter = new LangGraphAdapter({ graph: twoStepGraph() });
    const result = await adapter.invoke({ user: 'hello' });
    expect(result).toBe('>> HELLO');
  });

  it('honors a custom responseKey when the graph names its output field differently', async () => {
    const State = Annotation.Root({
      input: Annotation<string>,
      final: Annotation<string>,
    });
    const builder = new StateGraph(State)
      .addNode('done', (s) => ({ final: `final-${s.input}` }))
      .addEdge(START, 'done')
      .addEdge('done', END);
    const adapter = new LangGraphAdapter({
      graph: builder.compile() as unknown as CompiledGraph,
      responseKey: 'final',
    });
    const result = await adapter.invoke({ user: 'X' });
    expect(result).toBe('final-X');
  });

  it('honors a custom buildInitialState that maps spec to a different channel structure', async () => {
    const State = Annotation.Root({
      question: Annotation<string>,
      output: Annotation<string>,
    });
    const builder = new StateGraph(State)
      .addNode('answer', (s) => ({ output: `Q: ${s.question}` }))
      .addEdge(START, 'answer')
      .addEdge('answer', END);
    const adapter = new LangGraphAdapter({
      graph: builder.compile() as unknown as CompiledGraph,
      buildInitialState: (spec) => ({ question: spec.user }),
    });
    const result = await adapter.invoke({ user: 'are you ok?' });
    expect(result).toBe('Q: are you ok?');
  });

  it('emits an error event and re-throws when the graph fails', async () => {
    const events: AdapterEvent[] = [];
    const adapter = new LangGraphAdapter({ graph: throwingGraph() });
    adapter.events.subscribe((e) => events.push(e));
    await expect(adapter.invoke({ user: 'x' })).rejects.toThrow('intentional graph failure');

    const errorEvent = events.find((e) => e.kind === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('intentional graph failure'),
    });
  });

  it('coerces non-string responses to JSON when responseKey targets an object', async () => {
    const State = Annotation.Root({
      input: Annotation<string>,
      output: Annotation<{ value: number }>,
    });
    const builder = new StateGraph(State)
      .addNode('compute', () => ({ output: { value: 42 } }))
      .addEdge(START, 'compute')
      .addEdge('compute', END);
    const adapter = new LangGraphAdapter({
      graph: builder.compile() as unknown as CompiledGraph,
    });
    const result = await adapter.invoke({ user: 'ignored' });
    expect(result).toBe('{"value":42}');
  });

  it('returns empty string when the responseKey field is missing', async () => {
    const State = Annotation.Root({
      input: Annotation<string>,
      output: Annotation<string>,
    });
    const builder = new StateGraph(State)
      .addNode('noop', () => ({}))
      .addEdge(START, 'noop')
      .addEdge('noop', END);
    const adapter = new LangGraphAdapter({
      graph: builder.compile() as unknown as CompiledGraph,
    });
    const result = await adapter.invoke({ user: 'x' });
    expect(result).toBe('');
  });
});

/**
 * HarnessChatModel tests.
 *
 * Covers:
 *   - basic .invoke([HumanMessage]) returns adapter response
 *   - SystemMessage flattens into adapter's `system` field
 *   - multi-message conversations get role-labeled into `user`
 *   - single-HumanMessage shortcut returns bare content (no label)
 *   - works inside a real LangGraph node via .invoke()
 *   - createHarnessChatModel composes bindingToAdapter + the wrapper
 *
 * Uses a stub AgentAdapter that captures invocation specs — no real LLM.
 */

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { AdapterEventBus } from './events.ts';
import { createHarnessChatModel, HarnessChatModel } from './harness-chat-model.ts';
import type { CompiledGraph } from './langgraph-adapter.ts';
import type { AgentAdapter, InvocationSpec } from './types.ts';

class StubAdapter implements AgentAdapter {
  readonly events = new AdapterEventBus();
  readonly invocations: InvocationSpec[] = [];

  constructor(private readonly response: string = 'stub-response') {}

  async invoke(spec: InvocationSpec): Promise<string> {
    this.invocations.push(spec);
    return this.response;
  }
}

describe('HarnessChatModel', () => {
  it('returns the adapter response for a single HumanMessage', async () => {
    const adapter = new StubAdapter('answer-here');
    const model = new HarnessChatModel({ adapter });
    const result = await model.invoke([new HumanMessage('hi')]);
    expect(result.content).toBe('answer-here');
  });

  it('uses single-HumanMessage shortcut: bare content goes to adapter without role label', async () => {
    const adapter = new StubAdapter('ok');
    const model = new HarnessChatModel({ adapter });
    await model.invoke([new HumanMessage('what is 2+2?')]);
    expect(adapter.invocations).toHaveLength(1);
    expect(adapter.invocations[0]).toEqual({
      user: 'what is 2+2?',
    });
  });

  it('joins SystemMessages into the system field', async () => {
    const adapter = new StubAdapter();
    const model = new HarnessChatModel({ adapter });
    await model.invoke([new SystemMessage('you are concise'), new HumanMessage('hi')]);
    expect(adapter.invocations[0]).toMatchObject({
      system: 'you are concise',
      user: 'User: hi',
    });
  });

  it('joins multiple SystemMessages with double newlines', async () => {
    const adapter = new StubAdapter();
    const model = new HarnessChatModel({ adapter });
    await model.invoke([
      new SystemMessage('rule 1: be concise'),
      new SystemMessage('rule 2: be friendly'),
      new HumanMessage('hi'),
    ]);
    expect(adapter.invocations[0]?.system).toBe('rule 1: be concise\n\nrule 2: be friendly');
  });

  it('role-labels multi-turn conversations into the user field', async () => {
    const adapter = new StubAdapter();
    const model = new HarnessChatModel({ adapter });
    await model.invoke([
      new HumanMessage('what is 2+2?'),
      new AIMessage('4'),
      new HumanMessage('and what is 3+3?'),
    ]);
    expect(adapter.invocations[0]?.user).toBe(
      'User: what is 2+2?\n\nAssistant: 4\n\nUser: and what is 3+3?',
    );
  });

  it('handles ToolMessages with the Tool: label', async () => {
    const adapter = new StubAdapter();
    const model = new HarnessChatModel({ adapter });
    await model.invoke([
      new HumanMessage('check weather'),
      new AIMessage('calling weather tool'),
      new ToolMessage({ content: 'sunny, 72F', tool_call_id: 'wx-1' }),
      new HumanMessage('what should I wear?'),
    ]);
    expect(adapter.invocations[0]?.user).toContain('Tool: sunny, 72F');
  });

  it('reports llm type as harness-chat-model', () => {
    const model = new HarnessChatModel({ adapter: new StubAdapter() });
    expect(model._llmType()).toBe('harness-chat-model');
  });

  it('propagates adapter errors', async () => {
    const failingAdapter: AgentAdapter = {
      events: new AdapterEventBus(),
      async invoke() {
        throw new Error('adapter failure');
      },
    };
    const model = new HarnessChatModel({ adapter: failingAdapter });
    await expect(model.invoke([new HumanMessage('x')])).rejects.toThrow('adapter failure');
  });
});

describe('HarnessChatModel inside a LangGraph node', () => {
  it('a graph node can call the model and return its response in state', async () => {
    const adapter = new StubAdapter('graph-saw-this-from-LLM');
    const model = new HarnessChatModel({ adapter });

    const State = Annotation.Root({
      input: Annotation<string>,
      output: Annotation<string>,
    });
    const builder = new StateGraph(State)
      .addNode('llm-node', async (state) => {
        const response = await model.invoke([new HumanMessage(state.input)]);
        return { output: typeof response.content === 'string' ? response.content : '' };
      })
      .addEdge(START, 'llm-node')
      .addEdge('llm-node', END);
    const compiled = builder.compile() as unknown as CompiledGraph;

    const result = await compiled.invoke({ input: 'tell me a fact' });
    expect(result.output).toBe('graph-saw-this-from-LLM');
    expect(adapter.invocations).toHaveLength(1);
    expect(adapter.invocations[0]?.user).toBe('tell me a fact');
  });
});

describe('createHarnessChatModel — bindingToAdapter helper', () => {
  it('throws when binding is local but no localEndpoint is set anywhere', () => {
    expect(() =>
      createHarnessChatModel({
        binding: {
          kind: 'local',
          provider: { id: 'local-qwen', name: 'l', authMethods: [], models: [] },
          model: { id: 'qwen3', type: 'text' },
        },
        broker: {
          getCredential: async () => {
            throw new Error('not used for local binding');
          },
        },
        localEndpoint: () => undefined,
      }),
    ).toThrow(/no endpoint configured for local provider/);
  });

  it('builds a working chat model from a cloud-anthropic binding (delegates to ClaudeSdkAdapter constructor — does not invoke)', () => {
    const model = createHarnessChatModel({
      binding: {
        kind: 'cloud',
        provider: { id: 'anthropic', name: 'Anthropic', authMethods: ['api-key'], models: [] },
        model: { id: 'claude-haiku-4-5', type: 'text' },
        credential: { provider: 'anthropic', apiKey: 'sk-ant-stub', source: 'host-file' },
      },
      broker: {
        getCredential: async () => {
          throw new Error('test broker — should not be reached');
        },
      },
    });
    expect(model).toBeInstanceOf(HarnessChatModel);
    expect(model._llmType()).toBe('harness-chat-model');
  });
});

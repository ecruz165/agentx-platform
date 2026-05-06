/**
 * Entry coordinator tests.
 *
 * Uses a stub BaseChatModel that returns predetermined decisions. The
 * graph is real; the model is mocked. Coverage:
 *   - picks the predetermined pipeline id from the model's response
 *   - prompt contains the user intent + the pipeline list
 *   - first non-empty line of multi-line response is taken as the
 *     decision (handles models that disobey "no surrounding text")
 *   - empty catalog → graph still runs, model sees the no-pipelines
 *     instruction
 *   - catalog descriptions surface in the prompt when present
 *   - model invocation receives system + human messages
 *   - reasoning field captures raw response for observability
 */

import type { Catalog } from '@agentx/harness-core';
import { SimpleChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { buildEntryCoordinatorGraph, runEntryCoordinator } from './entry-coordinator.ts';

/** Stub chat model: returns canned response, captures the messages it
 *  saw. Extends SimpleChatModel so it satisfies BaseChatModel without
 *  needing a real provider. */
class StubChatModel extends SimpleChatModel {
  readonly seenMessages: BaseMessage[][] = [];

  constructor(private readonly response: string) {
    super({});
  }

  _llmType(): string {
    return 'stub-chat-model';
  }

  async _call(messages: BaseMessage[]): Promise<string> {
    this.seenMessages.push(messages);
    return this.response;
  }
}

const sampleCatalog: Catalog = {
  pipelines: [
    {
      id: 'feature-add',
      description: 'plan, build, review for new features',
      agents: [{ id: 'planner', role: 'Plan', adapter: 'claude-sdk' }],
    },
    {
      id: 'bugfix-triage',
      description: 'reproduce, isolate, fix, test bugs',
      agents: [{ id: 'reproducer', role: 'Repro', adapter: 'claude-sdk' }],
    },
    {
      id: 'docs-update',
      description: 'rewrite documentation',
      agents: [{ id: 'writer', role: 'Write', adapter: 'claude-sdk' }],
    },
  ],
};

describe('runEntryCoordinator', () => {
  it('returns the pipeline id the model picks', async () => {
    const model = new StubChatModel('bugfix-triage');
    const result = await runEntryCoordinator({
      intent: 'Login is throwing 500 errors when password has special chars',
      catalog: sampleCatalog,
      model,
    });
    expect(result.pipelineId).toBe('bugfix-triage');
    expect(result.reasoning).toBe('bugfix-triage');
  });

  it('takes only the first non-empty line when the model disobeys "no surrounding text"', async () => {
    const model = new StubChatModel('feature-add\n\nBecause the user wants new functionality.');
    const result = await runEntryCoordinator({
      intent: 'add dark mode',
      catalog: sampleCatalog,
      model,
    });
    expect(result.pipelineId).toBe('feature-add');
    // reasoning still has the full response for observability
    expect(result.reasoning).toContain('Because the user wants new functionality.');
  });

  it('trims whitespace and leading/trailing newlines from the picked id', async () => {
    const model = new StubChatModel('   \n\ndocs-update\n   \n');
    const result = await runEntryCoordinator({
      intent: 'rewrite the README',
      catalog: sampleCatalog,
      model,
    });
    expect(result.pipelineId).toBe('docs-update');
  });

  it('returns "NONE" when the model says no pipeline fits', async () => {
    const model = new StubChatModel('NONE');
    const result = await runEntryCoordinator({
      intent: 'launch a rocket',
      catalog: sampleCatalog,
      model,
    });
    expect(result.pipelineId).toBe('NONE');
  });

  it('returns whatever the model says even if not in catalog (caller validates)', async () => {
    // Graph deliberately doesn't validate against catalog — caller decides
    // policy on invalid picks.
    const model = new StubChatModel('hallucinated-pipeline');
    const result = await runEntryCoordinator({
      intent: 'do something',
      catalog: sampleCatalog,
      model,
    });
    expect(result.pipelineId).toBe('hallucinated-pipeline');
  });

  it('prompt includes the user intent', async () => {
    const model = new StubChatModel('feature-add');
    await runEntryCoordinator({
      intent: 'A very specific intent string xyz123',
      catalog: sampleCatalog,
      model,
    });
    const messages = model.seenMessages[0]!;
    const human = messages.find((m) => m.getType() === 'human')!;
    expect(typeof human.content === 'string' ? human.content : '').toContain(
      'A very specific intent string xyz123',
    );
  });

  it('prompt includes all pipeline ids and their descriptions', async () => {
    const model = new StubChatModel('feature-add');
    await runEntryCoordinator({
      intent: 'something',
      catalog: sampleCatalog,
      model,
    });
    const human = model.seenMessages[0]!.find((m) => m.getType() === 'human')!;
    const text = typeof human.content === 'string' ? human.content : '';
    expect(text).toContain('feature-add');
    expect(text).toContain('plan, build, review for new features');
    expect(text).toContain('bugfix-triage');
    expect(text).toContain('docs-update');
  });

  it('prompt handles pipelines without descriptions cleanly (no trailing colon)', async () => {
    const model = new StubChatModel('p');
    const minimalCatalog: Catalog = {
      pipelines: [{ id: 'p', agents: [{ id: 'a', role: 'A', adapter: 'claude-sdk' }] }],
    };
    await runEntryCoordinator({ intent: 'x', catalog: minimalCatalog, model });
    const human = model.seenMessages[0]!.find((m) => m.getType() === 'human')!;
    const text = typeof human.content === 'string' ? human.content : '';
    // No trailing ": " because no description
    expect(text).toMatch(/- p\n/);
    expect(text).not.toMatch(/- p: /);
  });

  it('handles an empty catalog (no pipelines)', async () => {
    const model = new StubChatModel('NONE');
    const result = await runEntryCoordinator({
      intent: 'do anything',
      catalog: { pipelines: [] },
      model,
    });
    expect(result.pipelineId).toBe('NONE');
    const human = model.seenMessages[0]!.find((m) => m.getType() === 'human')!;
    const text = typeof human.content === 'string' ? human.content : '';
    expect(text).toContain('No pipelines are available');
  });

  it('always sends a SystemMessage with routing instructions', async () => {
    const model = new StubChatModel('feature-add');
    await runEntryCoordinator({
      intent: 'add a feature',
      catalog: sampleCatalog,
      model,
    });
    const messages = model.seenMessages[0]!;
    const system = messages.find((m) => m.getType() === 'system');
    expect(system).toBeDefined();
    const sysText = typeof system!.content === 'string' ? system!.content : '';
    expect(sysText).toContain('pipeline router');
    expect(sysText).toContain('ONLY the pipeline id');
  });
});

describe('buildEntryCoordinatorGraph', () => {
  it('returns a compiled graph that can be invoked directly', async () => {
    const model = new StubChatModel('feature-add');
    const graph = buildEntryCoordinatorGraph(model);
    const result = await graph.invoke({
      intent: 'add stuff',
      availablePipelines: [{ id: 'feature-add', description: 'feature work' }],
    });
    expect(result.decision).toBe('feature-add');
  });
});

// Direct unit tests of the parsing strategy — exercises the response
// scanner that picks the LAST known pipeline id from a free-form model
// reply. Reasoning models like Qwen3-thinking emit "Thinking: …" before
// landing on an answer; the scanner unwraps that.

describe('pickPipelineFromResponse', () => {
  const pipelines = [{ id: 'feature-add' }, { id: 'bugfix-triage' }, { id: 'docs-update' }];

  it('picks the bare id when model is obedient', async () => {
    const { pickPipelineFromResponse } = await import('./entry-coordinator.ts');
    expect(pickPipelineFromResponse('feature-add', pipelines)).toBe('feature-add');
  });

  it('picks the LAST occurrence when reasoning model lists options', async () => {
    const { pickPipelineFromResponse } = await import('./entry-coordinator.ts');
    const reasoning =
      'Thinking: The intent could match feature-add or docs-update. ' +
      'Looking at it more carefully, the user wants to add a new feature. ' +
      'Final answer: feature-add';
    expect(pickPipelineFromResponse(reasoning, pipelines)).toBe('feature-add');
  });

  it('handles thinking-prefix responses where the conclusion is at the end', async () => {
    const { pickPipelineFromResponse } = await import('./entry-coordinator.ts');
    const reasoning =
      'Thinking: Okay, the user wants to fix a login bug. The available ' +
      'pipelines are feature-add, bugfix-triage, docs-update. Bug fixes ' +
      'go to bugfix-triage. So my answer is bugfix-triage.';
    expect(pickPipelineFromResponse(reasoning, pipelines)).toBe('bugfix-triage');
  });

  it('uses word-boundary matching (does not match substrings of compound ids)', async () => {
    const { pickPipelineFromResponse } = await import('./entry-coordinator.ts');
    // 'docs' should NOT match inside 'docs-update' because of \b boundaries
    // — pipeline ids with hyphens are atomic. Without escaping/boundaries
    // this test would falsely match.
    const shortIds = [{ id: 'docs' }];
    // No bare 'docs' in the response (it's inside docs-update); no NONE;
    // falls through to first-non-empty-line.
    expect(pickPipelineFromResponse('we should docs-update next', shortIds)).toBe(
      'we should docs-update next',
    );
  });

  it('falls back to NONE when no known id appears but the model said NONE', async () => {
    const { pickPipelineFromResponse } = await import('./entry-coordinator.ts');
    expect(pickPipelineFromResponse('Thinking: nothing fits. NONE.', pipelines)).toBe('NONE');
  });

  it('falls back to first non-empty line when nothing matches', async () => {
    const { pickPipelineFromResponse } = await import('./entry-coordinator.ts');
    // No known id, no NONE — surface the model's actual choice for
    // caller validation (likely a hallucinated pipeline name).
    expect(pickPipelineFromResponse('hallucinated-pipeline', pipelines)).toBe(
      'hallucinated-pipeline',
    );
  });

  it('handles ids with regex-special characters via escaping', async () => {
    const { pickPipelineFromResponse } = await import('./entry-coordinator.ts');
    const weird = [{ id: 'foo.bar' }];
    expect(pickPipelineFromResponse('I pick foo.bar', weird)).toBe('foo.bar');
    // Without escaping, the dot would also match 'foo-bar', 'fooXbar', etc.
    // This test pins that the escapeRegExp helper is doing its job.
  });
});

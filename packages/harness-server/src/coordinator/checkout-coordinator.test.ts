/**
 * Checkout coordinator tests.
 *
 * Mirrors entry-coordinator.test.ts — uses StubChatModel that returns
 * canned responses + captures messages it sees. Distillation is free-
 * form text, so tests assert structural properties of the prompt and
 * the wrapper behavior, not the LLM's content.
 *
 * Coverage:
 *   - returns the model's distillation as the lessons field
 *   - prompt includes jobId + intent + transcript
 *   - empty-transcript fallback prompt fires when transcript is blank
 *   - SystemMessage carries the distiller-role instructions
 *   - long transcripts pass through unchanged (no truncation in v1)
 *   - errors propagate from the model
 *   - buildCheckoutCoordinatorGraph compiled graph invocable directly
 */

import { SimpleChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { buildCheckoutCoordinatorGraph, runCheckoutCoordinator } from './checkout-coordinator.ts';

class StubChatModel extends SimpleChatModel {
  readonly seenMessages: BaseMessage[][] = [];

  constructor(private readonly response: string) {
    super({});
  }
  _llmType(): string {
    return 'stub';
  }
  async _call(messages: BaseMessage[]): Promise<string> {
    this.seenMessages.push(messages);
    if (this.response.startsWith('THROW:')) {
      throw new Error(this.response.slice('THROW:'.length));
    }
    return this.response;
  }
}

describe('runCheckoutCoordinator', () => {
  it('returns the distilled lessons string from the model', async () => {
    const model = new StubChatModel(
      'What went well:\n- Planner picked the right approach\n\n' +
        "What didn't:\n- Tests took 2 retries\n\n" +
        'Key lessons:\n- Run smoke tests before integration tests',
    );
    const result = await runCheckoutCoordinator({
      jobId: 'j1',
      intent: 'fix the auth bug',
      transcript: 'planner: identified issue\nimplementer: wrote fix\nreviewer: approved',
      model,
    });
    expect(result.lessons).toContain('What went well');
    expect(result.lessons).toContain('Run smoke tests before integration tests');
  });

  it('prompt includes the jobId, intent, and transcript', async () => {
    const model = new StubChatModel('lessons');
    await runCheckoutCoordinator({
      jobId: 'j-special-id-123',
      intent: 'specific intent abc',
      transcript: 'some unique transcript content xyz',
      model,
    });
    const human = model.seenMessages[0]!.find((m) => m.getType() === 'human')!;
    const text = typeof human.content === 'string' ? human.content : '';
    expect(text).toContain('j-special-id-123');
    expect(text).toContain('specific intent abc');
    expect(text).toContain('some unique transcript content xyz');
  });

  it('empty-transcript fallback prompt fires when transcript is blank', async () => {
    const model = new StubChatModel('nothing to report');
    await runCheckoutCoordinator({
      jobId: 'j-empty',
      intent: 'do nothing',
      transcript: '',
      model,
    });
    const human = model.seenMessages[0]!.find((m) => m.getType() === 'human')!;
    const text = typeof human.content === 'string' ? human.content : '';
    expect(text).toMatch(/empty.*no agent activity/);
  });

  it('treats whitespace-only transcripts the same as empty', async () => {
    const model = new StubChatModel('lessons');
    await runCheckoutCoordinator({
      jobId: 'j-ws',
      intent: 'x',
      transcript: '   \n\n  \t  ',
      model,
    });
    const human = model.seenMessages[0]!.find((m) => m.getType() === 'human')!;
    const text = typeof human.content === 'string' ? human.content : '';
    expect(text).toMatch(/empty.*no agent activity/);
  });

  it('always sends a SystemMessage with distiller-role instructions', async () => {
    const model = new StubChatModel('lessons');
    await runCheckoutCoordinator({
      jobId: 'j',
      intent: 'x',
      transcript: 'something happened',
      model,
    });
    const messages = model.seenMessages[0]!;
    const system = messages.find((m) => m.getType() === 'system');
    expect(system).toBeDefined();
    const sysText = typeof system!.content === 'string' ? system!.content : '';
    expect(sysText).toContain('lessons-learned');
    expect(sysText).toMatch(/What went well/);
    expect(sysText).toMatch(/What did not go well/);
    expect(sysText).toMatch(/Key lessons/);
  });

  it('passes long transcripts through unchanged (no v1 truncation)', async () => {
    const model = new StubChatModel('lessons');
    const long = `${'x '.repeat(1000)}unique-marker-here ${'y '.repeat(1000)}`;
    await runCheckoutCoordinator({
      jobId: 'j-long',
      intent: 'x',
      transcript: long,
      model,
    });
    const human = model.seenMessages[0]!.find((m) => m.getType() === 'human')!;
    const text = typeof human.content === 'string' ? human.content : '';
    expect(text).toContain('unique-marker-here');
  });

  it('propagates errors from the model', async () => {
    const model = new StubChatModel('THROW:upstream rate limit');
    await expect(
      runCheckoutCoordinator({
        jobId: 'j',
        intent: 'x',
        transcript: 't',
        model,
      }),
    ).rejects.toThrow(/upstream rate limit/);
  });
});

describe('buildCheckoutCoordinatorGraph', () => {
  it('returns a compiled graph that can be invoked directly', async () => {
    const model = new StubChatModel('direct-invoke-lessons');
    const graph = buildCheckoutCoordinatorGraph(model);
    const result = await graph.invoke({
      jobId: 'j-direct',
      intent: 'something',
      transcript: 'transcript content',
    });
    expect(result.lessons).toBe('direct-invoke-lessons');
  });
});

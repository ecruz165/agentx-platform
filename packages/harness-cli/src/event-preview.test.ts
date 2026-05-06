import { describe, expect, it } from 'vitest';
import type { Envelope } from '@agentx/harness-core';
import { eventPreview } from './event-preview.ts';

function env(event: Envelope['event']): Envelope {
  return { jobId: 'j1', agentId: 'planner', event };
}

describe('eventPreview', () => {
  it('renders request user text with whitespace collapsed', () => {
    expect(
      eventPreview(env({ kind: 'request', ts: 't', user: 'do  the\n  thing', model: 'm' }))
    ).toBe('do the thing');
  });

  it('renders response text with whitespace collapsed (no usage)', () => {
    expect(
      eventPreview(env({ kind: 'response', ts: 't', text: 'hello\n  world' }))
    ).toBe('hello world');
  });

  it('appends compact usage badge to response text when usage present', () => {
    expect(
      eventPreview(
        env({
          kind: 'response',
          ts: 't',
          text: 'reply',
          usage: { promptTokens: 1234, completionTokens: 340 },
        })
      )
    ).toBe('reply  [↑1.2k ↓340]');
  });

  it('omits usage badge when usage block has no signal (all zeros/missing)', () => {
    expect(
      eventPreview(
        env({
          kind: 'response',
          ts: 't',
          text: 'reply',
          usage: { promptTokens: 0, completionTokens: 0 },
        })
      )
    ).toBe('reply');
  });

  it('renders partial usage (only in or only out) as a real badge', () => {
    expect(
      eventPreview(
        env({
          kind: 'response',
          ts: 't',
          text: 'reply',
          usage: { promptTokens: 50 },
        })
      )
    ).toBe('reply  [↑50 ↓0]');
  });

  it('renders error message verbatim', () => {
    expect(
      eventPreview(env({ kind: 'error', ts: 't', message: 'rate-limited' }))
    ).toBe('rate-limited');
  });
});

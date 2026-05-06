/**
 * OpenAiChatAdapter tests — fetch-injection lets us stub the API call
 * end-to-end without network, and verify both happy-path usage
 * extraction (slice 13a) and typed-error classification (slice 13b).
 */

import type { CredentialBroker } from '@agentx/agent-auth';
import { describe, expect, it, vi } from 'vitest';
import { AuthError, BillingError, ConfigError, NetworkError, RateLimitError } from './errors.ts';
import type { AdapterEvent } from './events.ts';
import { OpenAiChatAdapter } from './openai-chat-adapter.ts';

interface MockResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function makeFetchStub(routes: Array<MockResponse | (() => MockResponse)>): {
  fn: typeof fetch;
  calls: number;
} {
  let i = 0;
  const stub: { calls: number } = { calls: 0 };
  const fn = (async () => {
    stub.calls += 1;
    const r = routes[i++] ?? routes[routes.length - 1]!;
    const route = typeof r === 'function' ? r() : r;
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status,
      headers: { 'Content-Type': 'application/json', ...(route.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fn, calls: stub.calls };
}

function makeBroker(apiKey = 'sk-proj-test'): CredentialBroker {
  return {
    getCredential: vi.fn().mockResolvedValue({
      provider: 'openai',
      apiKey,
      source: 'host-file',
    }),
  };
}

describe('OpenAiChatAdapter — happy path + usage', () => {
  it('returns the assistant message content', async () => {
    const { fn } = makeFetchStub([
      { status: 200, body: { choices: [{ message: { content: 'hello from openai' } }] } },
    ]);
    const adapter = new OpenAiChatAdapter({ broker: makeBroker(), fetchFn: fn });
    const result = await adapter.invoke({ user: 'hi' });
    expect(result).toBe('hello from openai');
  });

  it('emits usage on the response event when the API reports it', async () => {
    const { fn } = makeFetchStub([
      {
        status: 200,
        body: {
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
        },
      },
    ]);
    const events: AdapterEvent[] = [];
    const adapter = new OpenAiChatAdapter({ broker: makeBroker(), fetchFn: fn });
    adapter.events.subscribe((e) => events.push(e));
    await adapter.invoke({ user: 'hi' });

    const responseEvent = events.find((e) => e.kind === 'response') as Extract<
      AdapterEvent,
      { kind: 'response' }
    >;
    expect(responseEvent.usage).toEqual({
      promptTokens: 9,
      completionTokens: 3,
      totalTokens: 12,
    });
  });

  it('omits usage when API does not report it', async () => {
    const { fn } = makeFetchStub([
      { status: 200, body: { choices: [{ message: { content: 'no usage' } }] } },
    ]);
    const events: AdapterEvent[] = [];
    const adapter = new OpenAiChatAdapter({ broker: makeBroker(), fetchFn: fn });
    adapter.events.subscribe((e) => events.push(e));
    await adapter.invoke({ user: 'hi' });

    const responseEvent = events.find((e) => e.kind === 'response') as Extract<
      AdapterEvent,
      { kind: 'response' }
    >;
    expect(responseEvent.usage).toBeUndefined();
  });
});

describe('OpenAiChatAdapter — typed error classification', () => {
  it('401 → AuthError', async () => {
    const { fn } = makeFetchStub([{ status: 401, body: { error: 'invalid_api_key' } }]);
    const adapter = new OpenAiChatAdapter({ broker: makeBroker(), fetchFn: fn });
    let thrown: unknown;
    try {
      await adapter.invoke({ user: 'hi' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AuthError);
  });

  it('400 with quota body → BillingError', async () => {
    const { fn } = makeFetchStub([
      {
        status: 400,
        body: {
          error: { type: 'invalid_request_error', message: 'You exceeded your current quota' },
        },
      },
    ]);
    const adapter = new OpenAiChatAdapter({ broker: makeBroker(), fetchFn: fn });
    let thrown: unknown;
    try {
      await adapter.invoke({ user: 'hi' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BillingError);
  });

  it('400 with model-not-found → ConfigError', async () => {
    const { fn } = makeFetchStub([
      {
        status: 400,
        body: { error: { message: 'The model fake-model does not exist' } },
      },
    ]);
    const adapter = new OpenAiChatAdapter({ broker: makeBroker(), fetchFn: fn });
    let thrown: unknown;
    try {
      await adapter.invoke({ user: 'hi' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
  });

  it('429 with Retry-After → RateLimitError carrying retry-seconds', async () => {
    const { fn } = makeFetchStub([
      {
        status: 429,
        body: { error: 'rate limited' },
        headers: { 'retry-after': '15' },
      },
    ]);
    const adapter = new OpenAiChatAdapter({ broker: makeBroker(), fetchFn: fn });
    let thrown: unknown;
    try {
      await adapter.invoke({ user: 'hi' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RateLimitError);
    expect((thrown as RateLimitError).retryAfterSeconds).toBe(15);
  });

  it('network failure (fetch throws) → NetworkError', async () => {
    const fn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const adapter = new OpenAiChatAdapter({ broker: makeBroker(), fetchFn: fn });
    let thrown: unknown;
    try {
      await adapter.invoke({ user: 'hi' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NetworkError);
    expect((thrown as Error).message).toContain('ECONNREFUSED');
  });
});

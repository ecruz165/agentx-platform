import { describe, expect, it, vi } from 'vitest';
import type { AdapterEvent } from './events.ts';

const mockCreate = vi.fn();
// Mock the Anthropic SDK. The adapter also imports APIError from the
// same module for typed error classification — provide a stub class so
// the import resolves; tests can throw instances of it to exercise
// the HTTP-error classification path.
class MockAPIError extends Error {
  status?: number;
  headers?: Record<string, string>;
  error?: unknown;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'APIError';
    this.status = status;
  }
}
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
  APIError: MockAPIError,
}));

describe('ClaudeSdkAdapter', () => {
  it('emits request then response with system flowing through', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'hi from claude' }],
    });

    const { ClaudeSdkAdapter } = await import('./claude-sdk-adapter.ts');
    const broker = {
      getCredential: vi
        .fn()
        .mockResolvedValue({ provider: 'anthropic', apiKey: 'sk-ant-fake', source: 'test' }),
    };
    const adapter = new ClaudeSdkAdapter({
      broker: broker as unknown as ConstructorParameters<typeof ClaudeSdkAdapter>[0]['broker'],
    });

    const events: AdapterEvent[] = [];
    adapter.events.subscribe((e) => events.push(e));

    const text = await adapter.invoke({ system: 'be brief', user: 'say hi' });

    expect(text).toBe('hi from claude');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: 'request',
      system: 'be brief',
      user: 'say hi',
      provider: 'anthropic',
    });
    expect(events[1]).toMatchObject({ kind: 'response', text: 'hi from claude' });

    // The Anthropic SDK call should have received the system as a top-level field,
    // not folded into the user message — that's the whole point of the interface change.
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        system: 'be brief',
        messages: [{ role: 'user', content: 'say hi' }],
      }),
    );
  });

  it('omits the system field on the SDK call when no system prompt is provided', async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] });

    const { ClaudeSdkAdapter } = await import('./claude-sdk-adapter.ts');
    const broker = {
      getCredential: vi
        .fn()
        .mockResolvedValue({ provider: 'anthropic', apiKey: 'sk-ant-fake', source: 'test' }),
    };
    const adapter = new ClaudeSdkAdapter({
      broker: broker as unknown as ConstructorParameters<typeof ClaudeSdkAdapter>[0]['broker'],
    });

    await adapter.invoke({ user: 'plain' });

    const callArg = mockCreate.mock.calls[0]?.[0];
    expect(callArg).not.toHaveProperty('system');
  });

  it('emits an error event when the SDK throws', async () => {
    mockCreate.mockReset();
    mockCreate.mockRejectedValueOnce(new Error('rate limited'));

    const { ClaudeSdkAdapter } = await import('./claude-sdk-adapter.ts');
    const broker = {
      getCredential: vi
        .fn()
        .mockResolvedValue({ provider: 'anthropic', apiKey: 'sk-ant-fake', source: 'test' }),
    };
    const adapter = new ClaudeSdkAdapter({
      broker: broker as unknown as ConstructorParameters<typeof ClaudeSdkAdapter>[0]['broker'],
    });

    const events: AdapterEvent[] = [];
    adapter.events.subscribe((e) => events.push(e));

    // Slice 13b — non-APIError exceptions get wrapped in NetworkError
    // (the adapter classifies any non-HTTP-status error as a network
    // failure since the request never produced a structured response).
    // Original message is preserved as a substring.
    await expect(adapter.invoke({ user: 'go' })).rejects.toThrow(/rate limited/);

    expect(events.map((e) => e.kind)).toEqual(['request', 'error']);
    const errorEvent = events[1] as Extract<AdapterEvent, { kind: 'error' }>;
    expect(errorEvent.message).toContain('rate limited');
    expect(errorEvent.message).toContain('anthropic');
  });

  it('emits usage on the response event when the SDK reports it', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'with usage' }],
      usage: { input_tokens: 12, output_tokens: 7 },
    });

    const { ClaudeSdkAdapter } = await import('./claude-sdk-adapter.ts');
    const broker = {
      getCredential: vi
        .fn()
        .mockResolvedValue({ provider: 'anthropic', apiKey: 'sk-ant-fake', source: 'test' }),
    };
    const adapter = new ClaudeSdkAdapter({
      broker: broker as unknown as ConstructorParameters<typeof ClaudeSdkAdapter>[0]['broker'],
    });

    const events: AdapterEvent[] = [];
    adapter.events.subscribe((e) => events.push(e));
    await adapter.invoke({ user: 'hi' });

    const responseEvent = events.find((e) => e.kind === 'response') as Extract<
      AdapterEvent,
      { kind: 'response' }
    >;
    expect(responseEvent.usage).toEqual({
      promptTokens: 12,
      completionTokens: 7,
      totalTokens: 19,
    });
  });

  it('omits usage from response event when the SDK does not report any', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'no usage' }],
    });

    const { ClaudeSdkAdapter } = await import('./claude-sdk-adapter.ts');
    const broker = {
      getCredential: vi
        .fn()
        .mockResolvedValue({ provider: 'anthropic', apiKey: 'sk-ant-fake', source: 'test' }),
    };
    const adapter = new ClaudeSdkAdapter({
      broker: broker as unknown as ConstructorParameters<typeof ClaudeSdkAdapter>[0]['broker'],
    });

    const events: AdapterEvent[] = [];
    adapter.events.subscribe((e) => events.push(e));
    await adapter.invoke({ user: 'hi' });

    const responseEvent = events.find((e) => e.kind === 'response') as Extract<
      AdapterEvent,
      { kind: 'response' }
    >;
    expect(responseEvent.usage).toBeUndefined();
  });

  it('classifies APIError-style errors via the HTTP error classifier', async () => {
    // Mock APIError construct (matches what the SDK actually throws —
    // we set up MockAPIError above for this).
    const MockAPIError = (await import('@anthropic-ai/sdk')).APIError as unknown as {
      new (msg: string, status?: number): Error & { status?: number; error?: unknown };
    };
    const apiErr = new MockAPIError('Bad Request: credit balance too low', 400);
    (apiErr as { error?: unknown }).error = {
      type: 'invalid_request_error',
      message: 'credit balance too low',
    };
    mockCreate.mockRejectedValueOnce(apiErr);

    const { ClaudeSdkAdapter } = await import('./claude-sdk-adapter.ts');
    const { BillingError } = await import('./errors.ts');
    const broker = {
      getCredential: vi
        .fn()
        .mockResolvedValue({ provider: 'anthropic', apiKey: 'sk-ant-fake', source: 'test' }),
    };
    const adapter = new ClaudeSdkAdapter({
      broker: broker as unknown as ConstructorParameters<typeof ClaudeSdkAdapter>[0]['broker'],
    });

    let thrown: unknown;
    try {
      await adapter.invoke({ user: 'go' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BillingError);
  });
});

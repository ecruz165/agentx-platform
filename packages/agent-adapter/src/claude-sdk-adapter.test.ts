import { describe, expect, it, vi } from 'vitest';
import type { AdapterEvent } from './events.ts';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
    constructor(_opts: unknown) {}
  },
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
      })
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

    await expect(adapter.invoke({ user: 'go' })).rejects.toThrow('rate limited');

    expect(events.map((e) => e.kind)).toEqual(['request', 'error']);
    const errorEvent = events[1] as Extract<AdapterEvent, { kind: 'error' }>;
    expect(errorEvent.message).toBe('rate limited');
  });
});

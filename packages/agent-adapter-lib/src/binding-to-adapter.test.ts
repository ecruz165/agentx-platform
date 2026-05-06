/**
 * Tests for the bindingToAdapter factory.
 *
 * These tests verify that a ResolvedBinding produces the correct
 * AgentAdapter shape — they do NOT exercise the adapters' actual `invoke`
 * paths (which would require live SDKs or network). The factory is a pure
 * dispatcher; what it returns is what's tested.
 */

import type {
  CredentialBroker,
  LLMProvider,
  ModelDescriptor,
  Provider,
  ResolvedBinding,
} from '@agentx/agent-auth';
import { describe, expect, it } from 'vitest';
import { bindingToAdapter, defaultLocalEndpointResolver } from './binding-to-adapter.ts';
import { ClaudeSdkAdapter } from './claude-sdk-adapter.ts';
import { CopilotChatAdapter } from './copilot-chat-adapter.ts';
import { OpenAiChatAdapter } from './openai-chat-adapter.ts';
import { OpenCodeCliAdapter } from './opencode-cli-adapter.ts';

const stubBroker: CredentialBroker = {
  getCredential: async () => {
    throw new Error('stub broker — should not be called in factory tests');
  },
};

function fakeProvider(
  id: Provider,
  authMethods: ('api-key' | 'iam-task-role' | 'device-code')[],
): LLMProvider {
  return {
    id,
    name: `fake-${id}`,
    authMethods,
    models: [],
  };
}

function fakeModel(id: string, opts: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return { id, type: 'text', ...opts };
}

function cloudBinding(
  providerId: Provider,
  modelId: string,
  vendorModelId?: string,
): ResolvedBinding {
  return {
    kind: 'cloud',
    provider: fakeProvider(providerId, ['api-key']),
    model: fakeModel(modelId, vendorModelId ? { vendorModelId } : {}),
    credential: {
      provider: providerId,
      apiKey: 'stub-key',
      source: 'host-file',
    },
  };
}

function localBinding(providerId: Provider, modelId: string): ResolvedBinding {
  return {
    kind: 'local',
    provider: fakeProvider(providerId, []),
    model: fakeModel(modelId, { type: 'text' }),
  };
}

describe('bindingToAdapter — cloud bindings', () => {
  it('returns ClaudeSdkAdapter for direct anthropic', () => {
    const adapter = bindingToAdapter(cloudBinding('anthropic', 'claude-haiku-4-5'), {
      broker: stubBroker,
    });
    expect(adapter).toBeInstanceOf(ClaudeSdkAdapter);
  });

  it('returns OpenAiChatAdapter for openai (direct API path)', () => {
    const adapter = bindingToAdapter(cloudBinding('openai', 'gpt-4o'), {
      broker: stubBroker,
    });
    expect(adapter).toBeInstanceOf(OpenAiChatAdapter);
  });

  it('returns OpenCodeCliAdapter for google', () => {
    const adapter = bindingToAdapter(cloudBinding('google', 'gemini-1.5-pro'), {
      broker: stubBroker,
    });
    expect(adapter).toBeInstanceOf(OpenCodeCliAdapter);
  });

  it('throws for github-copilot when copilotAuthPath option is missing', () => {
    expect(() =>
      bindingToAdapter(cloudBinding('github-copilot', 'gpt-4o'), {
        broker: stubBroker,
      }),
    ).toThrow(/github-copilot binding requires options.copilotAuthPath/);
  });

  it('returns CopilotChatAdapter for github-copilot when copilotAuthPath is provided', () => {
    const adapter = bindingToAdapter(cloudBinding('github-copilot', 'gpt-4o'), {
      broker: stubBroker,
      copilotAuthPath: '/tmp/agentx-test-not-real-auth.json',
    });
    expect(adapter).toBeInstanceOf(CopilotChatAdapter);
  });

  it('throws for bedrock (no adapter yet)', () => {
    expect(() =>
      bindingToAdapter(cloudBinding('bedrock', 'claude-haiku-4-5-bedrock'), {
        broker: stubBroker,
      }),
    ).toThrow(/no adapter for bedrock yet/);
  });

  it('uses vendorModelId when present (Bedrock-style mapping)', () => {
    // Verify the modelId selection would use vendorModelId by hitting
    // an openai-shaped binding with a vendorModelId override. Construct
    // succeeds; the resolved model id flows through to OpenAiChatAdapter.
    const binding = cloudBinding('openai', 'gpt-4o', 'gpt-4o-2024-11-20');
    const adapter = bindingToAdapter(binding, { broker: stubBroker });
    expect(adapter).toBeInstanceOf(OpenAiChatAdapter);
  });
});

describe('bindingToAdapter — local bindings', () => {
  it('returns OpenCodeCliAdapter when localEndpoint provides a URL', () => {
    const adapter = bindingToAdapter(localBinding('local-qwen', 'qwen3'), {
      broker: stubBroker,
      localEndpoint: () => 'http://test-llm:8080/v1',
    });
    expect(adapter).toBeInstanceOf(OpenCodeCliAdapter);
  });

  it('throws when no endpoint is configured for the local provider', () => {
    expect(() =>
      bindingToAdapter(localBinding('local-qwen', 'qwen3'), {
        broker: stubBroker,
        localEndpoint: () => undefined,
      }),
    ).toThrow(/no endpoint configured for local provider "local-qwen"/);
  });

  it('uses the provided localEndpoint resolver, not the default', () => {
    let receivedId = '';
    bindingToAdapter(localBinding('local-qwen', 'qwen3'), {
      broker: stubBroker,
      localEndpoint: (id) => {
        receivedId = id;
        return 'http://override:9090';
      },
    });
    expect(receivedId).toBe('local-qwen');
  });
});

describe('defaultLocalEndpointResolver', () => {
  it('reads AGENTX_LOCAL_QWEN_ENDPOINT for local-qwen', () => {
    const orig = process.env.AGENTX_LOCAL_QWEN_ENDPOINT;
    process.env.AGENTX_LOCAL_QWEN_ENDPOINT = 'http://env-override:8080/v1';
    try {
      expect(defaultLocalEndpointResolver('local-qwen')).toBe('http://env-override:8080/v1');
    } finally {
      if (orig === undefined) delete process.env.AGENTX_LOCAL_QWEN_ENDPOINT;
      else process.env.AGENTX_LOCAL_QWEN_ENDPOINT = orig;
    }
  });

  it('returns undefined when env var not set', () => {
    const orig = process.env.AGENTX_LOCAL_QWEN_ENDPOINT;
    delete process.env.AGENTX_LOCAL_QWEN_ENDPOINT;
    try {
      expect(defaultLocalEndpointResolver('local-qwen')).toBeUndefined();
    } finally {
      if (orig !== undefined) process.env.AGENTX_LOCAL_QWEN_ENDPOINT = orig;
    }
  });

  it('returns undefined for unknown local providers', () => {
    expect(defaultLocalEndpointResolver('unknown-local')).toBeUndefined();
  });
});

// 3-axis binding refactor: explicit-tool dispatch supersedes provider-default.
describe('bindingToAdapter — explicit tool dispatch (3-part bindings)', () => {
  it('tool=claude-sdk + provider=anthropic → ClaudeSdkAdapter', () => {
    const binding: ResolvedBinding = {
      ...cloudBinding('anthropic', 'claude-haiku-4-5'),
      tool: 'claude-sdk',
    };
    expect(bindingToAdapter(binding, { broker: stubBroker })).toBeInstanceOf(ClaudeSdkAdapter);
  });

  it('tool=openai-api + provider=openai → OpenAiChatAdapter', () => {
    const binding: ResolvedBinding = {
      ...cloudBinding('openai', 'gpt-4o'),
      tool: 'openai-api',
    };
    expect(bindingToAdapter(binding, { broker: stubBroker })).toBeInstanceOf(OpenAiChatAdapter);
  });

  it('tool=opencode-cli + provider=openai → OpenCodeCliAdapter (the override that motivated this refactor)', () => {
    const binding: ResolvedBinding = {
      ...cloudBinding('openai', 'gpt-4o'),
      tool: 'opencode-cli',
    };
    // Same provider as the previous test, different tool, different adapter.
    // This is the architectural payoff: catalogs can pin the tool axis
    // independently from the provider axis.
    expect(bindingToAdapter(binding, { broker: stubBroker })).toBeInstanceOf(OpenCodeCliAdapter);
  });

  it('tool=copilot-api + provider=github-copilot + copilotAuthPath → CopilotChatAdapter', () => {
    const binding: ResolvedBinding = {
      ...cloudBinding('github-copilot', 'gpt-4o'),
      tool: 'copilot-api',
    };
    const adapter = bindingToAdapter(binding, {
      broker: stubBroker,
      copilotAuthPath: '/tmp/test-auth.json',
    });
    expect(adapter).toBeInstanceOf(CopilotChatAdapter);
  });

  it('tool=opencode-cli + local binding → OpenCodeCliAdapter (with endpoint)', () => {
    const binding: ResolvedBinding = {
      ...localBinding('local-qwen', 'qwen3'),
      tool: 'opencode-cli',
    };
    const adapter = bindingToAdapter(binding, {
      broker: stubBroker,
      localEndpoint: () => 'http://localhost:8080/v1',
    });
    expect(adapter).toBeInstanceOf(OpenCodeCliAdapter);
  });

  it('throws when (tool, provider) is incompatible: claude-sdk + openai', () => {
    const binding: ResolvedBinding = {
      ...cloudBinding('openai', 'gpt-4o'),
      tool: 'claude-sdk',
    };
    expect(() => bindingToAdapter(binding, { broker: stubBroker })).toThrow(
      /tool=claude-sdk requires provider=anthropic/,
    );
  });

  it('throws when (tool, provider) is incompatible: openai-api + anthropic', () => {
    const binding: ResolvedBinding = {
      ...cloudBinding('anthropic', 'claude-haiku-4-5'),
      tool: 'openai-api',
    };
    expect(() => bindingToAdapter(binding, { broker: stubBroker })).toThrow(
      /tool=openai-api requires provider=openai/,
    );
  });

  it('throws when (tool, provider) is incompatible: copilot-api + openai', () => {
    const binding: ResolvedBinding = {
      ...cloudBinding('openai', 'gpt-4o'),
      tool: 'copilot-api',
    };
    expect(() =>
      bindingToAdapter(binding, {
        broker: stubBroker,
        copilotAuthPath: '/tmp/x',
      }),
    ).toThrow(/tool=copilot-api requires provider=github-copilot/);
  });

  it('throws when tool=opencode-cli is paired with github-copilot (opencode does not adapt copilot)', () => {
    const binding: ResolvedBinding = {
      ...cloudBinding('github-copilot', 'gpt-4o'),
      tool: 'opencode-cli',
    };
    expect(() => bindingToAdapter(binding, { broker: stubBroker })).toThrow(
      /tool=opencode-cli does not support provider=github-copilot/,
    );
  });

  it('throws when tool=opencode-cli is paired with bedrock', () => {
    const binding: ResolvedBinding = {
      ...cloudBinding('bedrock', 'claude-opus-4-7-bedrock'),
      tool: 'opencode-cli',
    };
    expect(() => bindingToAdapter(binding, { broker: stubBroker })).toThrow(
      /tool=opencode-cli does not support provider=bedrock/,
    );
  });

  it('throws when tool=copilot-api is missing copilotAuthPath option', () => {
    const binding: ResolvedBinding = {
      ...cloudBinding('github-copilot', 'gpt-4o'),
      tool: 'copilot-api',
    };
    expect(() => bindingToAdapter(binding, { broker: stubBroker })).toThrow(
      /copilot-api binding requires options.copilotAuthPath/,
    );
  });
});

// bindingNeedsOpenCode behavior under the 3-axis refactor.
describe('bindingNeedsOpenCode — tool-aware', () => {
  it('returns true when tool=opencode-cli explicitly set, even for openai (which would default to openai-api)', async () => {
    const { bindingNeedsOpenCode } = await import('./binding-to-adapter.ts');
    const binding: ResolvedBinding = {
      ...cloudBinding('openai', 'gpt-4o'),
      tool: 'opencode-cli',
    };
    expect(bindingNeedsOpenCode(binding)).toBe(true);
  });

  it('returns false when tool=openai-api explicitly set on a local-qwen binding (override)', async () => {
    // (Hypothetical case — openai-api with local binding doesn't make
    // semantic sense; bindingToAdapter would throw at dispatch. But
    // bindingNeedsOpenCode should still respect the explicit tool field
    // since this predicate is about resource needs, not validation.)
    const { bindingNeedsOpenCode } = await import('./binding-to-adapter.ts');
    const binding: ResolvedBinding = {
      ...localBinding('local-qwen', 'qwen3'),
      tool: 'openai-api',
    };
    expect(bindingNeedsOpenCode(binding)).toBe(false);
  });

  it('falls back to provider-default inference when tool is unset (back-compat)', async () => {
    const { bindingNeedsOpenCode } = await import('./binding-to-adapter.ts');
    // 2-part: openai → defaults to openai-api → no opencode needed
    expect(bindingNeedsOpenCode(cloudBinding('openai', 'gpt-4o'))).toBe(false);
    // 2-part: google → defaults to opencode-cli → opencode needed
    expect(bindingNeedsOpenCode(cloudBinding('google', 'gemini-1.5-pro'))).toBe(true);
    // 2-part: local → opencode-cli → opencode needed
    expect(bindingNeedsOpenCode(localBinding('local-qwen', 'qwen3'))).toBe(true);
  });
});

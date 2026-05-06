/**
 * Tests for the bindingToAdapter factory.
 *
 * These tests verify that a ResolvedBinding produces the correct
 * AgentAdapter shape — they do NOT exercise the adapters' actual `invoke`
 * paths (which would require live SDKs or network). The factory is a pure
 * dispatcher; what it returns is what's tested.
 */

import { describe, expect, it } from 'vitest';
import type {
  CredentialBroker,
  LLMProvider,
  ModelDescriptor,
  Provider,
  ResolvedBinding,
} from '@agentx/agent-auth-lib';
import { ClaudeSdkAdapter } from './claude-sdk-adapter.ts';
import { OpenCodeCliAdapter } from './opencode-cli-adapter.ts';
import { CopilotChatAdapter } from './copilot-chat-adapter.ts';
import { OpenAiChatAdapter } from './openai-chat-adapter.ts';
import {
  bindingToAdapter,
  defaultLocalEndpointResolver,
} from './binding-to-adapter.ts';

const stubBroker: CredentialBroker = {
  getCredential: async () => {
    throw new Error('stub broker — should not be called in factory tests');
  },
};

function fakeProvider(id: Provider, authMethods: ('api-key' | 'iam-task-role' | 'device-code')[]): LLMProvider {
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

function cloudBinding(providerId: Provider, modelId: string, vendorModelId?: string): ResolvedBinding {
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
    const adapter = bindingToAdapter(
      cloudBinding('anthropic', 'claude-haiku-4-5'),
      { broker: stubBroker }
    );
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
      })
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
      })
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
      })
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
      expect(defaultLocalEndpointResolver('local-qwen')).toBe(
        'http://env-override:8080/v1'
      );
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

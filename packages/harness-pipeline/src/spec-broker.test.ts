/**
 * SpecBroker tests — verifies the read-only window onto pre-resolved
 * credentials behaves correctly, including the same-provider deduplication
 * (multiple bindings to the same provider share one credential).
 */

import { describe, expect, it } from 'vitest';
import type { ResolvedBinding } from '@agentx/agent-auth-lib';
import { SpecBroker } from './spec-broker.ts';

function cloudBinding(provider: 'anthropic' | 'openai' | 'google', apiKey: string): ResolvedBinding {
  return {
    kind: 'cloud',
    provider: { id: provider, name: provider, authMethods: ['api-key'], models: [] },
    model: { id: `${provider}-stub-model`, type: 'text' },
    credential: { provider, apiKey, source: 'host-file' },
  };
}

function localBinding(): ResolvedBinding {
  return {
    kind: 'local',
    provider: { id: 'local-qwen', name: 'local', authMethods: [], models: [] },
    model: { id: 'qwen3', type: 'text' },
  };
}

describe('SpecBroker', () => {
  it('returns the credential for a registered cloud binding', async () => {
    const broker = new SpecBroker({ a: cloudBinding('anthropic', 'sk-ant-1') });
    const cred = await broker.getCredential('anthropic');
    expect(cred.apiKey).toBe('sk-ant-1');
    expect(cred.provider).toBe('anthropic');
  });

  it('throws when asked for a provider not present in bindings', async () => {
    const broker = new SpecBroker({ a: cloudBinding('anthropic', 'sk-ant-1') });
    await expect(broker.getCredential('openai')).rejects.toThrow(
      /no credential for provider "openai"/
    );
  });

  it('throws when bindings is empty', async () => {
    const broker = new SpecBroker({});
    await expect(broker.getCredential('anthropic')).rejects.toThrow(/no credential/);
  });

  it('handles multiple bindings to the same provider — first credential wins', async () => {
    // Two agents using anthropic models share the same anthropic credential.
    // The "first wins" rule is OK because authentication is provider-scoped,
    // not model-scoped — Anthropic's api-key works for any Claude model.
    const broker = new SpecBroker({
      planner:  cloudBinding('anthropic', 'sk-ant-FIRST'),
      reviewer: cloudBinding('anthropic', 'sk-ant-SECOND'),
    });
    const cred = await broker.getCredential('anthropic');
    expect(cred.apiKey).toBe('sk-ant-FIRST');
  });

  it('coexists with local bindings — only cloud contributes credentials', async () => {
    const broker = new SpecBroker({
      planner:  cloudBinding('anthropic', 'sk-ant-1'),
      summarizer: localBinding(),
      reviewer: cloudBinding('openai', 'sk-oa-1'),
    });
    expect((await broker.getCredential('anthropic')).apiKey).toBe('sk-ant-1');
    expect((await broker.getCredential('openai')).apiKey).toBe('sk-oa-1');
    // Local-only providers don't contribute credentials.
    await expect(broker.getCredential('local-qwen')).rejects.toThrow(/no credential/);
  });

  it('isolates broker instances — different specs build different brokers', async () => {
    const a = new SpecBroker({ x: cloudBinding('anthropic', 'sk-A') });
    const b = new SpecBroker({ x: cloudBinding('anthropic', 'sk-B') });
    expect((await a.getCredential('anthropic')).apiKey).toBe('sk-A');
    expect((await b.getCredential('anthropic')).apiKey).toBe('sk-B');
  });
});

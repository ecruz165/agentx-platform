/**
 * Binding resolver tests.
 *
 * Two layers of test:
 *   1. `resolveBindingFor` — the pure function. Stubbed
 *      getCredentialOrThrow simulates auth state without any FS / broker
 *      machinery.
 *   2. `DefaultBindingResolver` — the class wrapping a CredentialBroker.
 *      Stub broker; same algorithmic coverage, but exercises the
 *      composition path.
 *
 * Pinned invariants:
 *   - First match wins (priority order honored)
 *   - Local providers (empty authMethods) satisfy immediately
 *   - Cloud providers skip silently when getCredential throws
 *   - Malformed / unknown accept-list entries are skipped with a
 *     diagnostic, not silently dropped
 *   - When nothing matches, BindingResolutionError carries every failure
 *     reason
 */

import { describe, expect, it } from 'vitest';
import {
  BindingResolutionError,
  DefaultBindingResolver,
  type ResolvedBinding,
  resolveAllBindingsFor,
  resolveBindingFor,
} from './binding-resolver.ts';
import type { Credential, CredentialBroker, Provider } from './types.ts';

// ─── stubs ────────────────────────────────────────────────────────────────

/** Build a getCredentialOrThrow stub from a static map of authenticated
 *  providers. Throws "not configured" for missing providers, mirroring
 *  what FileBroker would do. */
function stubGetCred(
  authed: Partial<Record<Provider, Credential>>,
): (id: Provider) => Promise<Credential> {
  return async (id) => {
    const cred = authed[id];
    if (!cred) {
      throw new Error(`provider ${id} not configured`);
    }
    return cred;
  };
}

function fakeCred(provider: Provider): Credential {
  return {
    provider,
    apiKey: `stub-${provider}-key`,
    source: 'host-file',
  };
}

/** Stub CredentialBroker for the DefaultBindingResolver tests. */
class StubBroker implements CredentialBroker {
  constructor(private readonly authed: Partial<Record<Provider, Credential>>) {}
  async getCredential(provider: Provider): Promise<Credential> {
    const cred = this.authed[provider];
    if (!cred) throw new Error(`provider ${provider} not configured`);
    return cred;
  }
}

// ─── resolveBindingFor (pure function) ────────────────────────────────────

describe('resolveBindingFor', () => {
  it('returns cloud binding when first entry has auth', async () => {
    const result = await resolveBindingFor(
      ['anthropic:claude-haiku-4-5', 'local-qwen:qwen3'],
      stubGetCred({ anthropic: fakeCred('anthropic') }),
    );
    expect(result.kind).toBe('cloud');
    expect(result.provider.id).toBe('anthropic');
    expect(result.model.id).toBe('claude-haiku-4-5');
    if (result.kind === 'cloud') {
      expect(result.credential.apiKey).toBe('stub-anthropic-key');
    }
  });

  it('falls back to second entry when first lacks auth', async () => {
    const result = await resolveBindingFor(
      ['anthropic:claude-haiku-4-5', 'openai:gpt-4o'],
      stubGetCred({ openai: fakeCred('openai') }),
    );
    expect(result.kind).toBe('cloud');
    expect(result.provider.id).toBe('openai');
    expect(result.model.id).toBe('gpt-4o');
  });

  it('falls back to local when no cloud entry has auth', async () => {
    const result = await resolveBindingFor(
      ['anthropic:claude-haiku-4-5', 'openai:gpt-4o', 'local-qwen:qwen3'],
      stubGetCred({}),
    );
    expect(result.kind).toBe('local');
    expect(result.provider.id).toBe('local-qwen');
    expect(result.model.id).toBe('qwen3');
  });

  it('honors priority — local first beats authenticated cloud', async () => {
    // If the catalog says "prefer local even when cloud is available,"
    // the resolver respects that ordering.
    const result = await resolveBindingFor(
      ['local-qwen:qwen3', 'anthropic:claude-haiku-4-5'],
      stubGetCred({ anthropic: fakeCred('anthropic') }),
    );
    expect(result.kind).toBe('local');
    expect(result.provider.id).toBe('local-qwen');
  });

  it('skips entries not in the registry, continues to next', async () => {
    const result = await resolveBindingFor(
      ['anthropic:fake-model-name', 'local-qwen:qwen3'],
      stubGetCred({}),
    );
    expect(result.kind).toBe('local');
  });

  it('skips unknown providers, continues to next', async () => {
    const result = await resolveBindingFor(
      ['mystery-provider:foo', 'local-qwen:qwen3'],
      stubGetCred({}),
    );
    expect(result.kind).toBe('local');
  });

  it('skips malformed entries (no colon)', async () => {
    const result = await resolveBindingFor(['anthropic', 'local-qwen:qwen3'], stubGetCred({}));
    expect(result.kind).toBe('local');
  });

  it('skips entries with empty model id', async () => {
    const result = await resolveBindingFor(['anthropic:', 'local-qwen:qwen3'], stubGetCred({}));
    expect(result.kind).toBe('local');
  });

  it('throws BindingResolutionError when nothing satisfies', async () => {
    await expect(
      resolveBindingFor(['anthropic:claude-haiku-4-5', 'openai:gpt-4o'], stubGetCred({})),
    ).rejects.toThrow(BindingResolutionError);
  });

  it('error carries the original accepts list AND every failure reason', async () => {
    let caught: BindingResolutionError | null = null;
    try {
      await resolveBindingFor(['anthropic:fake-model', 'openai:gpt-4o'], stubGetCred({}));
    } catch (err) {
      caught = err as BindingResolutionError;
    }
    expect(caught).toBeInstanceOf(BindingResolutionError);
    expect(caught?.accepts).toEqual(['anthropic:fake-model', 'openai:gpt-4o']);
    expect(caught?.failures).toHaveLength(2);
    expect(caught?.failures[0]).toContain('not in registry');
    expect(caught?.failures[1]).toContain('not configured');
  });

  it('throws BindingResolutionError on empty accept-list', async () => {
    await expect(resolveBindingFor([], stubGetCred({}))).rejects.toThrow(BindingResolutionError);
  });

  it('preserves the model descriptor type field on cloud bindings', async () => {
    const result = await resolveBindingFor(
      ['openai:text-embedding-3-small'],
      stubGetCred({ openai: fakeCred('openai') }),
    );
    expect(result.kind).toBe('cloud');
    expect(result.model.type).toBe('text-embedding');
    expect(result.model.embeddingDim).toBe(1536);
  });

  it('preserves the model descriptor type field on local bindings', async () => {
    const result = await resolveBindingFor(['local-qwen:qwen3-embedding'], stubGetCred({}));
    expect(result.kind).toBe('local');
    expect(result.model.type).toBe('text-embedding');
    expect(result.model.embeddingDim).toBe(1024);
  });

  it('returns vendorModelId on bedrock bindings (resolver passes through)', async () => {
    const result = await resolveBindingFor(
      ['bedrock:claude-haiku-4-5-bedrock'],
      stubGetCred({ bedrock: fakeCred('bedrock') }),
    );
    expect(result.kind).toBe('cloud');
    expect(result.model.vendorModelId).toMatch(/^anthropic\./);
  });
});

// ─── DefaultBindingResolver (composes a CredentialBroker) ─────────────────

describe('DefaultBindingResolver', () => {
  it('delegates to the wrapped broker for cloud entries', async () => {
    const broker = new StubBroker({ anthropic: fakeCred('anthropic') });
    const resolver = new DefaultBindingResolver(broker);
    const result = await resolver.resolveBinding(['anthropic:claude-haiku-4-5']);
    expect(result.kind).toBe('cloud');
    expect(result.provider.id).toBe('anthropic');
  });

  it('does not call the broker for local entries (no auth needed)', async () => {
    let calls = 0;
    const broker: CredentialBroker = {
      getCredential: async (p) => {
        calls += 1;
        throw new Error(`should not be called: ${p}`);
      },
    };
    const resolver = new DefaultBindingResolver(broker);
    const result = await resolver.resolveBinding(['local-qwen:qwen3']);
    expect(result.kind).toBe('local');
    expect(calls).toBe(0);
  });

  it('propagates BindingResolutionError when nothing satisfies', async () => {
    const resolver = new DefaultBindingResolver(new StubBroker({}));
    await expect(resolver.resolveBinding(['anthropic:claude-haiku-4-5'])).rejects.toThrow(
      BindingResolutionError,
    );
  });

  it('walks the broker once per cloud entry until one succeeds', async () => {
    const calls: Provider[] = [];
    const broker: CredentialBroker = {
      getCredential: async (p) => {
        calls.push(p);
        if (p === 'openai') return fakeCred('openai');
        throw new Error(`provider ${p} not configured`);
      },
    };
    const resolver = new DefaultBindingResolver(broker);
    const result = await resolver.resolveBinding([
      'anthropic:claude-haiku-4-5',
      'google:gemini-1.5-pro',
      'openai:gpt-4o',
    ]);
    expect(result.kind).toBe('cloud');
    expect((result as Extract<ResolvedBinding, { kind: 'cloud' }>).provider.id).toBe('openai');
    // anthropic + google + openai called in order, openai succeeds last
    expect(calls).toEqual(['anthropic', 'google', 'openai']);
  });
});

// ─── resolveAllBindingsFor (slice 13c — fallback enumeration) ─────────────

describe('resolveAllBindingsFor', () => {
  it('returns every authenticated cloud binding in priority order', async () => {
    const result = await resolveAllBindingsFor(
      ['anthropic:claude-haiku-4-5', 'openai:gpt-4o'],
      stubGetCred({
        anthropic: fakeCred('anthropic'),
        openai: fakeCred('openai'),
      }),
    );
    expect(result).toHaveLength(2);
    expect(result[0]?.provider.id).toBe('anthropic');
    expect(result[1]?.provider.id).toBe('openai');
  });

  it('mixes local + cloud — local satisfied without broker call', async () => {
    const result = await resolveAllBindingsFor(
      ['anthropic:claude-haiku-4-5', 'local-qwen:qwen3', 'openai:gpt-4o'],
      stubGetCred({ openai: fakeCred('openai') }),
    );
    // anthropic skipped (no auth); local satisfied; openai authenticated.
    expect(result).toHaveLength(2);
    expect(result[0]?.kind).toBe('local');
    expect(result[0]?.provider.id).toBe('local-qwen');
    expect(result[1]?.kind).toBe('cloud');
    expect(result[1]?.provider.id).toBe('openai');
  });

  it('skips unauthenticated entries silently — no failures collected', async () => {
    const result = await resolveAllBindingsFor(
      ['anthropic:claude-haiku-4-5', 'openai:gpt-4o'],
      stubGetCred({ openai: fakeCred('openai') }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.provider.id).toBe('openai');
  });

  it('returns empty array when nothing is satisfiable — does NOT throw', async () => {
    const result = await resolveAllBindingsFor(
      ['anthropic:claude-haiku-4-5', 'openai:gpt-4o'],
      stubGetCred({}),
    );
    expect(result).toEqual([]);
  });

  it('returns empty array for empty accept-list', async () => {
    const result = await resolveAllBindingsFor([], stubGetCred({}));
    expect(result).toEqual([]);
  });

  it('skips unknown providers and malformed entries silently', async () => {
    const result = await resolveAllBindingsFor(
      [
        'mystery:foo', // unknown provider
        'anthropic:fake-model', // unknown model
        'anthropic', // no colon
        'anthropic:', // empty model
        'local-qwen:qwen3', // valid
      ],
      stubGetCred({}),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.provider.id).toBe('local-qwen');
  });

  it('propagates the tool field on 3-part bindings', async () => {
    // 3-part: <tool>:<provider>:<model>. claude-sdk:anthropic:... is the
    // explicit-tool form per memory `project_three_axis_binding`.
    const result = await resolveAllBindingsFor(
      ['claude-sdk:anthropic:claude-haiku-4-5'],
      stubGetCred({ anthropic: fakeCred('anthropic') }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.tool).toBe('claude-sdk');
  });

  it('omits the tool field on 2-part bindings (legacy shorthand)', async () => {
    const result = await resolveAllBindingsFor(
      ['anthropic:claude-haiku-4-5'],
      stubGetCred({ anthropic: fakeCred('anthropic') }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.tool).toBeUndefined();
  });
});

describe('DefaultBindingResolver.resolveAllBindings', () => {
  it('delegates to the broker and returns all satisfiable bindings', async () => {
    const broker = new StubBroker({
      anthropic: fakeCred('anthropic'),
      openai: fakeCred('openai'),
    });
    const resolver = new DefaultBindingResolver(broker);
    const result = await resolver.resolveAllBindings([
      'anthropic:claude-haiku-4-5',
      'openai:gpt-4o',
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]?.provider.id).toBe('anthropic');
    expect(result[1]?.provider.id).toBe('openai');
  });

  it('returns empty array (does not throw) when nothing satisfies', async () => {
    const resolver = new DefaultBindingResolver(new StubBroker({}));
    const result = await resolver.resolveAllBindings(['anthropic:claude-haiku-4-5']);
    expect(result).toEqual([]);
  });
});

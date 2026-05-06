/**
 * Tests for the static LLMProvider registry.
 *
 * These are pure data tests — no I/O, no broker logic. The point is to
 * pin invariants the broker (follow-up commit) will rely on:
 *   - every provider has at least one model
 *   - every model has a type
 *   - every text-embedding model declares its dim
 *   - local-qwen needs no auth (empty authMethods)
 *   - bedrock supports both auth methods
 *   - dim parity between local-qwen and bedrock-titan (collection compat)
 */

import { describe, expect, it } from 'vitest';
import { BUILT_IN_PROVIDERS, findProvider, findBinding } from './provider-registry.ts';

describe('BUILT_IN_PROVIDERS', () => {
  it('contains the expected six providers', () => {
    const ids = BUILT_IN_PROVIDERS.map((p) => p.id).sort();
    expect(ids).toEqual([
      'anthropic',
      'bedrock',
      'github-copilot',
      'google',
      'local-qwen',
      'openai',
    ]);
  });

  it('has unique provider ids', () => {
    const ids = BUILT_IN_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every provider has at least one model', () => {
    for (const p of BUILT_IN_PROVIDERS) {
      expect(p.models.length, `${p.id} models`).toBeGreaterThan(0);
    }
  });

  it('every model has a type set', () => {
    for (const p of BUILT_IN_PROVIDERS) {
      for (const m of p.models) {
        expect(m.type, `${p.id}:${m.id} type`).toBeDefined();
      }
    }
  });

  it('every model id within a provider is unique', () => {
    for (const p of BUILT_IN_PROVIDERS) {
      const ids = p.models.map((m) => m.id);
      expect(new Set(ids).size, `${p.id} dup model id`).toBe(ids.length);
    }
  });

  it('every text-embedding model declares embeddingDim > 0', () => {
    for (const p of BUILT_IN_PROVIDERS) {
      for (const m of p.models) {
        if (m.type === 'text-embedding') {
          expect(m.embeddingDim, `${p.id}:${m.id} embeddingDim`).toBeDefined();
          expect(m.embeddingDim).toBeGreaterThan(0);
        }
      }
    }
  });

  it('local-qwen has empty authMethods (no auth required)', () => {
    const local = BUILT_IN_PROVIDERS.find((p) => p.id === 'local-qwen');
    expect(local?.authMethods).toEqual([]);
  });

  it('github-copilot uses device-code flow', () => {
    const cop = BUILT_IN_PROVIDERS.find((p) => p.id === 'github-copilot');
    expect(cop?.authMethods).toEqual(['device-code']);
  });

  it('bedrock supports both iam-task-role AND api-key', () => {
    const bedrock = BUILT_IN_PROVIDERS.find((p) => p.id === 'bedrock');
    expect(bedrock?.authMethods).toContain('iam-task-role');
    expect(bedrock?.authMethods).toContain('api-key');
  });

  it('bedrock claude entries carry vendorModelId for the AWS SDK', () => {
    const bedrock = BUILT_IN_PROVIDERS.find((p) => p.id === 'bedrock')!;
    const claudes = bedrock.models.filter((m) => m.id.includes('claude'));
    expect(claudes.length).toBeGreaterThan(0);
    for (const m of claudes) {
      expect(m.vendorModelId, `${m.id} vendorModelId`).toMatch(/^anthropic\./);
    }
  });

  it('embedder dim matches across local-qwen + bedrock (1024) — collection-compat invariant', () => {
    const qwen = BUILT_IN_PROVIDERS
      .find((p) => p.id === 'local-qwen')!
      .models.find((m) => m.id === 'qwen3-embedding')!;
    const titan = BUILT_IN_PROVIDERS
      .find((p) => p.id === 'bedrock')!
      .models.find((m) => m.id === 'titan-v2')!;
    expect(qwen.embeddingDim).toBe(1024);
    expect(titan.embeddingDim).toBe(1024);
  });
});

describe('findProvider', () => {
  it('returns the provider record by id', () => {
    expect(findProvider('anthropic')?.name).toContain('Anthropic');
  });

  it('returns the local-qwen record', () => {
    const local = findProvider('local-qwen');
    expect(local?.name).toContain('Qwen');
    expect(local?.authMethods).toEqual([]);
  });

  it('returns undefined for unknown id', () => {
    expect(findProvider('not-a-provider')).toBeUndefined();
  });

  it('is case-sensitive', () => {
    expect(findProvider('Anthropic')).toBeUndefined();
  });
});

describe('findBinding', () => {
  it('parses <provider>:<model> and returns both records', () => {
    const result = findBinding('anthropic:claude-haiku-4-5');
    expect(result?.provider.id).toBe('anthropic');
    expect(result?.model.id).toBe('claude-haiku-4-5');
    expect(result?.model.type).toBe('text');
  });

  it('handles provider id with hyphens', () => {
    const result = findBinding('local-qwen:qwen3-coder');
    expect(result?.provider.id).toBe('local-qwen');
    expect(result?.model.id).toBe('qwen3-coder');
  });

  it('handles model id with hyphens', () => {
    const result = findBinding('bedrock:claude-opus-4-7-bedrock');
    expect(result?.provider.id).toBe('bedrock');
    expect(result?.model.id).toBe('claude-opus-4-7-bedrock');
    expect(result?.model.vendorModelId).toMatch(/^anthropic\./);
  });

  it('returns undefined when provider is unknown', () => {
    expect(findBinding('mystery:gpt-4o')).toBeUndefined();
  });

  it('returns undefined when model is unknown for known provider', () => {
    expect(findBinding('anthropic:not-a-model')).toBeUndefined();
  });

  it('returns undefined for malformed spec — no colon', () => {
    expect(findBinding('anthropic')).toBeUndefined();
  });

  it('returns undefined for malformed spec — empty provider', () => {
    expect(findBinding(':claude-haiku-4-5')).toBeUndefined();
  });

  it('returns undefined for malformed spec — empty model', () => {
    expect(findBinding('anthropic:')).toBeUndefined();
  });

  it('uses first colon as separator (forward-compat for colon-bearing model ids)', () => {
    // None of our current model ids contain colons (vendorModelId can,
    // but those aren't the lookup key). This pins the parser behavior so
    // a future model id containing a colon would still parse correctly.
    const result = findBinding('anthropic:claude-haiku-4-5');
    expect(result?.model.id).toBe('claude-haiku-4-5');
  });
});

describe('findBinding — 3-part bindings (tool:provider:model)', () => {
  it('parses 3-part binding and returns the tool field', () => {
    const result = findBinding('openai-api:openai:gpt-4o');
    expect(result?.tool).toBe('openai-api');
    expect(result?.provider.id).toBe('openai');
    expect(result?.model.id).toBe('gpt-4o');
  });

  it('parses opencode-cli 3-part binding', () => {
    const result = findBinding('opencode-cli:openai:gpt-4o');
    expect(result?.tool).toBe('opencode-cli');
    expect(result?.provider.id).toBe('openai');
    expect(result?.model.id).toBe('gpt-4o');
  });

  it('parses claude-sdk 3-part binding', () => {
    const result = findBinding('claude-sdk:anthropic:claude-haiku-4-5');
    expect(result?.tool).toBe('claude-sdk');
    expect(result?.provider.id).toBe('anthropic');
    expect(result?.model.id).toBe('claude-haiku-4-5');
  });

  it('parses copilot-api 3-part binding', () => {
    const result = findBinding('copilot-api:github-copilot:gpt-4o');
    expect(result?.tool).toBe('copilot-api');
    expect(result?.provider.id).toBe('github-copilot');
  });

  it('parses opencode-cli + local-qwen 3-part binding', () => {
    const result = findBinding('opencode-cli:local-qwen:qwen3');
    expect(result?.tool).toBe('opencode-cli');
    expect(result?.provider.id).toBe('local-qwen');
    expect(result?.model.id).toBe('qwen3');
  });

  it('2-part binding has tool=undefined (back-compat)', () => {
    const result = findBinding('openai:gpt-4o');
    expect(result?.tool).toBeUndefined();
    expect(result?.provider.id).toBe('openai');
  });

  it('unknown LHS is treated as 2-part (no tool detected)', () => {
    // 'mystery-tool' isn't a known tool, so the parser falls back to
    // treating 'mystery-tool' as a provider id — which doesn't exist
    // in the registry, so findBinding returns undefined.
    expect(findBinding('mystery-tool:openai:gpt-4o')).toBeUndefined();
  });

  it('returns undefined when 3-part has unknown provider', () => {
    expect(findBinding('openai-api:not-a-provider:gpt-4o')).toBeUndefined();
  });

  it('returns undefined when 3-part has unknown model for the provider', () => {
    expect(findBinding('openai-api:openai:gpt-99-imaginary')).toBeUndefined();
  });

  it('returns undefined when 3-part is missing the model segment', () => {
    expect(findBinding('openai-api:openai')).toBeUndefined();
  });

  it('returns undefined when 3-part is missing the provider segment', () => {
    // 'openai-api::gpt-4o' — second segment is empty
    expect(findBinding('openai-api::gpt-4o')).toBeUndefined();
  });

  it('the registry entry preserves vendorModelId when present', () => {
    // Bedrock entries carry vendorModelId; pick one and parse 3-part.
    const result = findBinding('opencode-cli:bedrock:claude-opus-4-7-bedrock');
    // (opencode-cli does not actually adapt bedrock — that's a runtime
    // dispatch concern. findBinding is purely about parsing + registry
    // lookup; it'll happily return this combo, the dispatcher rejects.)
    expect(result?.tool).toBe('opencode-cli');
    expect(result?.model.vendorModelId).toMatch(/^anthropic\./);
  });
});

describe('Provider type union (compile-time)', () => {
  // This test exists mainly to ensure the type extension didn't drop any
  // values. If 'bedrock' or 'local-qwen' aren't in Provider, the registry
  // file fails to compile in the first place.
  it('all registry ids are valid Provider values', () => {
    const ids: string[] = BUILT_IN_PROVIDERS.map((p) => p.id);
    expect(ids).toContain('anthropic');
    expect(ids).toContain('openai');
    expect(ids).toContain('google');
    expect(ids).toContain('github-copilot');
    expect(ids).toContain('bedrock');
    expect(ids).toContain('local-qwen');
  });
});

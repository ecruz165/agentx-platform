/**
 * Tests for the lazy-acquisition predicate and the URL-passthrough path.
 *
 * Verifies:
 *   - specNeedsOpenCode returns true for any local OR openai/google binding
 *   - specNeedsOpenCode returns false for pure-anthropic OR no-binding specs
 *   - When caller provides opencodeServerUrl, runHarnessPipeline does NOT
 *     start its own server (lifecycle is caller's)
 *   - When caller omits the URL AND no agent needs opencode, no server starts
 *   - opencodeServerStarted in the result accurately reports the decision
 *
 * Does NOT test the "spawns its own server when needed" path here — that
 * path requires a real opencode binary or an extensive mock; it lives in
 * the gated integration tests.
 */

import { describe, expect, it } from 'vitest';
import type { ResolvedBinding } from '@agentx/agent-auth-lib';
import { runHarnessPipeline, specNeedsOpenCode, type JobSpec } from './index.ts';

function anthropicBinding(): ResolvedBinding {
  return {
    kind: 'cloud',
    provider: { id: 'anthropic', name: 'Anthropic', authMethods: ['api-key'], models: [] },
    model: { id: 'claude-haiku-4-5', type: 'text' },
    credential: { provider: 'anthropic', apiKey: 'sk-ant-stub', source: 'host-file' },
  };
}

function openaiBinding(): ResolvedBinding {
  return {
    kind: 'cloud',
    provider: { id: 'openai', name: 'OpenAI', authMethods: ['api-key'], models: [] },
    model: { id: 'gpt-4o', type: 'text' },
    credential: { provider: 'openai', apiKey: 'sk-oa-stub', source: 'host-file' },
  };
}

function googleBinding(): ResolvedBinding {
  return {
    kind: 'cloud',
    provider: { id: 'google', name: 'Google', authMethods: ['api-key'], models: [] },
    model: { id: 'gemini-1.5-pro', type: 'text' },
    credential: { provider: 'google', apiKey: 'goog-stub', source: 'host-file' },
  };
}

function localBinding(): ResolvedBinding {
  return {
    kind: 'local',
    provider: { id: 'local-qwen', name: 'Local', authMethods: [], models: [] },
    model: { id: 'qwen3', type: 'text' },
  };
}

function specWithBindings(bindings: Record<string, ResolvedBinding>): JobSpec {
  return {
    version: 1,
    jobId: 'test',
    pipeline: 'p',
    set: 'default',
    input: 'go',
    agents: Object.keys(bindings).map((id) => ({
      id,
      role: id,
      adapter: 'opencode-cli' as const,
      bindingId: id,
    })),
    bindings,
  };
}

describe('specNeedsOpenCode', () => {
  it('returns false for pure-anthropic spec', () => {
    expect(specNeedsOpenCode(specWithBindings({ a: anthropicBinding() }))).toBe(false);
  });

  it('returns true for openai binding', () => {
    expect(specNeedsOpenCode(specWithBindings({ a: openaiBinding() }))).toBe(true);
  });

  it('returns true for google binding', () => {
    expect(specNeedsOpenCode(specWithBindings({ a: googleBinding() }))).toBe(true);
  });

  it('returns true for local binding', () => {
    expect(specNeedsOpenCode(specWithBindings({ a: localBinding() }))).toBe(true);
  });

  it('returns true for mixed spec with at least one opencode-needing binding', () => {
    expect(specNeedsOpenCode(specWithBindings({
      a: anthropicBinding(),
      b: openaiBinding(),
    }))).toBe(true);
  });

  it('returns false for empty bindings (no-binding-only synthetic agents)', () => {
    expect(specNeedsOpenCode({
      version: 1,
      jobId: 'synth',
      pipeline: 'p',
      set: 'default',
      input: 'go',
      agents: [{ id: 'coordinator', role: 'C', adapter: 'claude-sdk' }],
      bindings: {},
    })).toBe(false);
  });
});

describe('runHarnessPipeline opencode-server lifecycle', () => {
  it('does NOT start a server when no agent needs one (pure-anthropic)', async () => {
    const spec = specWithBindings({ planner: anthropicBinding() });
    const result = await runHarnessPipeline(spec);
    expect(result.opencodeServerStarted).toBe(false);
  });

  it('does NOT start a server when caller provides opencodeServerUrl', async () => {
    // Even a binding that needs opencode (local) shouldn't trigger an
    // internal spawn when the caller supplies a URL.
    const spec = specWithBindings({ a: localBinding() });
    const result = await runHarnessPipeline(spec, {
      opencodeServerUrl: 'http://test:9999',
      localEndpoint: () => 'http://test:8080/v1',
    });
    expect(result.opencodeServerStarted).toBe(false);
  });

  it('does NOT start a server for synthetic-only spec (no bindings)', async () => {
    const spec: JobSpec = {
      version: 1,
      jobId: 'synth',
      pipeline: 'p',
      set: 'default',
      input: 'go',
      agents: [{ id: 'coordinator', role: 'C', adapter: 'claude-sdk' }],
      bindings: {},
    };
    const result = await runHarnessPipeline(spec);
    expect(result.opencodeServerStarted).toBe(false);
  });
});

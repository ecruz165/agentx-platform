/**
 * JobSpec parser tests.
 *
 * Covers the spec.json contract — version pinning, structural shape, and
 * referential integrity (every agent's bindingId must point at a real
 * binding in the map).
 */

import { describe, expect, it } from 'vitest';
import { type JobSpec, JobSpecError, parseJobSpec } from './spec.ts';

const validBinding = {
  kind: 'cloud' as const,
  provider: {
    id: 'anthropic' as const,
    name: 'Anthropic',
    authMethods: ['api-key' as const],
    models: [],
  },
  model: { id: 'claude-haiku-4-5', type: 'text' as const },
  credential: {
    provider: 'anthropic' as const,
    apiKey: 'sk-ant-stub',
    source: 'host-file' as const,
  },
};

function validSpec(): JobSpec {
  return {
    version: 1,
    jobId: 'job-001',
    pipeline: 'feature-add',
    set: 'default',
    input: 'do the thing',
    agents: [{ id: 'planner', role: 'Plan', adapter: 'claude-sdk', bindingId: 'planner' }],
    bindings: {
      planner: validBinding,
    },
  };
}

describe('parseJobSpec', () => {
  it('accepts a valid v1 spec', () => {
    expect(() => parseJobSpec(validSpec())).not.toThrow();
  });

  it('rejects non-object input', () => {
    expect(() => parseJobSpec(null)).toThrow(JobSpecError);
    expect(() => parseJobSpec('hello')).toThrow(JobSpecError);
    expect(() => parseJobSpec(42)).toThrow(JobSpecError);
  });

  it('rejects unsupported version', () => {
    expect(() => parseJobSpec({ ...validSpec(), version: 2 })).toThrow(/unsupported version/);
    expect(() => parseJobSpec({ ...validSpec(), version: undefined })).toThrow(
      /unsupported version/,
    );
  });

  it('rejects missing jobId', () => {
    const s = validSpec();
    expect(() => parseJobSpec({ ...s, jobId: '' })).toThrow(/jobId must be a non-empty string/);
    const { jobId, ...withoutJobId } = s;
    void jobId;
    expect(() => parseJobSpec(withoutJobId)).toThrow(/jobId/);
  });

  it('rejects missing set', () => {
    const s = validSpec();
    expect(() => parseJobSpec({ ...s, set: '' })).toThrow(/set must be a non-empty string/);
  });

  it('rejects non-array agents', () => {
    expect(() => parseJobSpec({ ...validSpec(), agents: 'not-array' })).toThrow(
      /agents must be an array/,
    );
  });

  it('rejects non-object bindings', () => {
    expect(() => parseJobSpec({ ...validSpec(), bindings: 'not-object' })).toThrow(
      /bindings must be an object/,
    );
  });

  it('rejects an agent with empty role', () => {
    const s = validSpec();
    expect(() => parseJobSpec({ ...s, agents: [{ ...s.agents[0]!, role: '' }] })).toThrow(
      /role must be a non-empty string/,
    );
  });

  it('rejects an agent with unknown adapter', () => {
    const s = validSpec();
    expect(() =>
      parseJobSpec({ ...s, agents: [{ ...s.agents[0]!, adapter: 'gpt-direct' }] }),
    ).toThrow(/adapter must be "claude-sdk" or "opencode-cli"/);
  });

  it('rejects an agent with bindingId not present in bindings map', () => {
    const s = validSpec();
    expect(() =>
      parseJobSpec({ ...s, agents: [{ ...s.agents[0]!, bindingId: 'nonexistent' }] }),
    ).toThrow(/bindingId "nonexistent" not present in bindings map/);
  });

  it('rejects an agent with empty bindingId string', () => {
    const s = validSpec();
    expect(() => parseJobSpec({ ...s, agents: [{ ...s.agents[0]!, bindingId: '' }] })).toThrow(
      /bindingId must be a non-empty string when present/,
    );
  });

  it('accepts an agent without bindingId (synthetic / placeholder agent)', () => {
    const s = validSpec();
    const { bindingId, ...withoutBinding } = s.agents[0]!;
    void bindingId;
    expect(() => parseJobSpec({ ...s, agents: [withoutBinding] })).not.toThrow();
  });

  it('accepts a multi-agent spec where some have bindings and others do not', () => {
    const s: JobSpec = {
      ...validSpec(),
      agents: [
        { id: 'coordinator', role: 'Coordinator', adapter: 'claude-sdk' },
        { id: 'planner', role: 'Plan', adapter: 'claude-sdk', bindingId: 'planner' },
        { id: 'reviewer', role: 'Review', adapter: 'claude-sdk', bindingId: 'reviewer' },
      ],
      bindings: {
        planner: validBinding,
        reviewer: validBinding,
      },
    };
    expect(() => parseJobSpec(s)).not.toThrow();
  });
});

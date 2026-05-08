/**
 * Unit tests for the OpenAPI 3.1 spec generation.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildOpenApiSpec, zodToJsonSchema } from './openapi.ts';

describe('zodToJsonSchema — vocabulary coverage', () => {
  it('z.string / z.number / z.boolean', () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: 'string' });
    expect(zodToJsonSchema(z.number())).toEqual({ type: 'number' });
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: 'boolean' });
  });

  it('z.literal', () => {
    expect(zodToJsonSchema(z.literal('hello'))).toEqual({ const: 'hello' });
  });

  it('z.enum', () => {
    expect(zodToJsonSchema(z.enum(['a', 'b']))).toEqual({
      type: 'string',
      enum: ['a', 'b'],
    });
  });

  it('z.array', () => {
    expect(zodToJsonSchema(z.array(z.string()))).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('z.object — required + optional', () => {
    const schema = z.object({
      a: z.string(),
      b: z.number().optional(),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'number' },
      },
      required: ['a'],
    });
  });

  it('z.record', () => {
    expect(zodToJsonSchema(z.record(z.number()))).toEqual({
      type: 'object',
      additionalProperties: { type: 'number' },
    });
  });

  it('z.discriminatedUnion → oneOf', () => {
    const u = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), x: z.string() }),
      z.object({ kind: z.literal('b'), y: z.number() }),
    ]);
    const out = zodToJsonSchema(u);
    expect(out.oneOf).toHaveLength(2);
  });

  it('unknown construct returns loose `{}` (forward-compat)', () => {
    expect(zodToJsonSchema(z.unknown())).toEqual({});
  });
});

describe('buildOpenApiSpec — top-level shape', () => {
  it('emits openapi 3.1.0 + info + paths + components', () => {
    const spec = buildOpenApiSpec();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info?.title).toBe('edge-memory-server');
    expect(spec.info?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(spec.paths).toBeDefined();
    expect(spec.components?.schemas).toBeDefined();
  });

  it('includes every PRD-mandated route', () => {
    const spec = buildOpenApiSpec();
    const required = [
      '/health',
      '/metrics',
      '/v1/memory/put',
      '/v1/memory/query',
      '/v1/memory/forget',
      '/v1/memory/export',
      '/v1/memory/import',
      '/v1/memory/tag',
      '/v1/memory/consolidate',
      '/v1/memory/cleanup-unconfirmed',
      '/v1/memory/snapshot',
      '/v1/memory/restore',
      '/v1/memory/inspect',
      '/v1/audit',
    ];
    for (const path of required) {
      expect(spec.paths[path]).toBeDefined();
    }
  });

  it('routes have summary + responses with 4xx/5xx documented', () => {
    const spec = buildOpenApiSpec();
    const op = spec.paths['/v1/memory/put'].post;
    expect(op.summary).toBeTruthy();
    expect(op.responses[200]).toBeDefined();
    expect(op.responses[400]).toBeDefined();
    expect(op.responses[500]).toBeDefined();
  });

  it('schemas referenced by $ref resolve to component definitions', () => {
    const spec = buildOpenApiSpec();
    const putBodyRef =
      spec.paths['/v1/memory/put'].post.requestBody.content['application/json'].schema.$ref;
    expect(putBodyRef).toBe('#/components/schemas/PutInput');
    expect(spec.components.schemas.PutInput).toBeDefined();
    expect(spec.components.schemas.PutInput.type).toBe('object');
  });

  it('MemoryQuery component is a oneOf discriminated union', () => {
    const spec = buildOpenApiSpec();
    const q = spec.components.schemas.MemoryQuery;
    expect(q.oneOf).toBeDefined();
    expect(q.oneOf.length).toBe(4); // structured | recent | similarity | graph
  });
});

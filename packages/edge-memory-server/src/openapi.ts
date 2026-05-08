/**
 * OpenAPI 3.1 spec — auto-generated from Zod schemas (PRD F11).
 *
 * Approach: Zod schemas are the canonical source of truth. We
 * derive JSON Schema 2020-12 (which OpenAPI 3.1 uses unmodified)
 * via a small conversion helper that handles the vocabulary we
 * actually use: z.object / z.string / z.number / z.boolean /
 * z.literal / z.enum / z.array / z.optional / z.union (discriminated).
 *
 * Why hand-roll vs `@asteasolutions/zod-to-openapi`? Cold-start
 * budget: that package + its peer deps load ~400ms in the worst
 * case. The spec is small enough that a 100-LOC helper covers our
 * needs and keeps the daemon fast.
 *
 * The spec is exposed at `GET /openapi.json` for tooling
 * (Postman / Insomnia / Swagger UI / OpenAPI codegen). When schemas
 * change, the spec changes — no separate doc to update.
 */

import { type ZodTypeAny, z } from 'zod';
import {
  ConsolidateInputSchema,
  ConsolidateResultSchema,
  HealthResponseSchema,
  ImportResultSchema,
  InspectInputSchema,
  InspectResultSchema,
  MemoryEntrySchema,
  MemoryForgetPredicateSchema,
  MemoryForgetResultSchema,
  MemoryQueryResultSchema,
  MemoryQuerySchema,
  MemoryScopeSchema,
  MemoryTagInputSchema,
  MemoryTagResultSchema,
  PutInputSchema,
  RestoreInputSchema,
  RestoreResultSchema,
  SnapshotInputSchema,
  SnapshotResultSchema,
} from './schemas.ts';

// biome-ignore lint/suspicious/noExplicitAny: spec output is loosely typed by design
type JsonSchema = Record<string, any>;

interface OpenApiOperation {
  summary: string;
  requestBody?: { schemaName?: string; contentType?: string };
  response: { schemaName?: string; status?: number };
}

const COMPONENT_SCHEMAS: Record<string, ZodTypeAny> = {
  MemoryScope: MemoryScopeSchema,
  MemoryEntry: MemoryEntrySchema,
  MemoryQuery: MemoryQuerySchema,
  MemoryQueryResult: MemoryQueryResultSchema,
  MemoryForgetPredicate: MemoryForgetPredicateSchema,
  MemoryForgetResult: MemoryForgetResultSchema,
  MemoryTagInput: MemoryTagInputSchema,
  MemoryTagResult: MemoryTagResultSchema,
  PutInput: PutInputSchema,
  ConsolidateInput: ConsolidateInputSchema,
  ConsolidateResult: ConsolidateResultSchema,
  SnapshotInput: SnapshotInputSchema,
  SnapshotResult: SnapshotResultSchema,
  RestoreInput: RestoreInputSchema,
  RestoreResult: RestoreResultSchema,
  InspectInput: InspectInputSchema,
  InspectResult: InspectResultSchema,
  ImportResult: ImportResultSchema,
  HealthResponse: HealthResponseSchema,
};

const OPERATIONS: Record<string, Record<string, OpenApiOperation>> = {
  '/health': {
    get: { summary: 'Liveness + backend state', response: { schemaName: 'HealthResponse' } },
  },
  '/metrics': {
    get: {
      summary: 'Prometheus exposition (PRD F13)',
      response: { schemaName: undefined, status: 200 },
    },
  },
  '/v1/memory/put': {
    post: {
      summary: 'Store an entry',
      requestBody: { schemaName: 'PutInput' },
      response: { schemaName: 'MemoryEntry' },
    },
  },
  '/v1/memory/query': {
    post: {
      summary: 'Retrieve entries',
      requestBody: { schemaName: 'MemoryQuery' },
      response: { schemaName: 'MemoryQueryResult' },
    },
  },
  '/v1/memory/forget': {
    post: {
      summary: 'GDPR-compliant predicate-based delete',
      requestBody: { schemaName: 'MemoryForgetPredicate' },
      response: { schemaName: 'MemoryForgetResult' },
    },
  },
  '/v1/memory/export': {
    post: {
      summary: 'Stream matching entries as JSONL',
      requestBody: { schemaName: 'MemoryQuery' },
      response: { schemaName: undefined, status: 200 },
    },
  },
  '/v1/memory/import': {
    post: {
      summary: 'Bulk import from JSONL',
      requestBody: { schemaName: undefined, contentType: 'text/plain' },
      response: { schemaName: 'ImportResult' },
    },
  },
  '/v1/memory/tag': {
    post: {
      summary: 'Feedback-tag entries (PRD F18)',
      requestBody: { schemaName: 'MemoryTagInput' },
      response: { schemaName: 'MemoryTagResult' },
    },
  },
  '/v1/memory/consolidate': {
    post: {
      summary: 'Promote feedback-tagged entries to wider scope (PRD F14/F15)',
      requestBody: { schemaName: 'ConsolidateInput' },
      response: { schemaName: 'ConsolidateResult' },
    },
  },
  '/v1/memory/cleanup-unconfirmed': {
    post: {
      summary: 'Delete unconfirmed entries within scope (PRD F19)',
      requestBody: { schemaName: 'MemoryForgetPredicate' },
      response: { schemaName: 'MemoryForgetResult' },
    },
  },
  '/v1/memory/snapshot': {
    post: {
      summary: 'Capture entries matching scope (PRD F5)',
      requestBody: { schemaName: 'SnapshotInput' },
      response: { schemaName: 'SnapshotResult' },
    },
  },
  '/v1/memory/restore': {
    post: {
      summary: 'Restore a snapshot by id (PRD F5)',
      requestBody: { schemaName: 'RestoreInput' },
      response: { schemaName: 'RestoreResult' },
    },
  },
  '/v1/memory/inspect': {
    post: {
      summary: 'Aggregate scope breakdown (PRD F37)',
      requestBody: { schemaName: 'InspectInput' },
      response: { schemaName: 'InspectResult' },
    },
  },
  '/v1/audit': {
    post: {
      summary: 'Read audit log (PRD F12)',
      requestBody: { schemaName: undefined },
      response: { schemaName: undefined },
    },
  },
};

export function buildOpenApiSpec(): JsonSchema {
  const components: JsonSchema = {};
  for (const [name, schema] of Object.entries(COMPONENT_SCHEMAS)) {
    components[name] = zodToJsonSchema(schema);
  }

  const paths: JsonSchema = {};
  for (const [path, methods] of Object.entries(OPERATIONS)) {
    const m: JsonSchema = {};
    for (const [method, op] of Object.entries(methods)) {
      m[method] = {
        summary: op.summary,
        ...(op.requestBody
          ? {
              requestBody: {
                required: true,
                content: {
                  [op.requestBody.contentType ?? 'application/json']: op.requestBody.schemaName
                    ? { schema: { $ref: `#/components/schemas/${op.requestBody.schemaName}` } }
                    : { schema: { type: 'string' } },
                },
              },
            }
          : {}),
        responses: {
          [op.response.status ?? 200]: {
            description: 'OK',
            content: op.response.schemaName
              ? {
                  'application/json': {
                    schema: { $ref: `#/components/schemas/${op.response.schemaName}` },
                  },
                }
              : { 'text/plain': { schema: { type: 'string' } } },
          },
          400: { description: 'Bad Request' },
          404: { description: 'Not Found' },
          500: { description: 'Server Error' },
        },
      };
    }
    paths[path] = m;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'edge-memory-server',
      version: '1.0.0',
      description:
        'UDS-fronted memory store for agentx workers. Scope-aware, GDPR-compliant, vector-similarity-capable.',
    },
    paths,
    components: { schemas: components },
  };
}

/**
 * Minimal Zod → JSON Schema 2020-12 / OpenAPI 3.1 converter for the
 * vocabulary used by our schemas. Public API: pass any Zod schema,
 * get back a plain JsonSchema object.
 *
 * Intentionally limited — we only emit shapes our schemas use, not
 * the full Zod surface. If a new construct shows up, add the case.
 */
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const def = schema._def;
  const typeName = def.typeName as string;

  switch (typeName) {
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodLiteral':
      return { const: def.value };
    case 'ZodEnum':
      return { type: 'string', enum: def.values };
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema(def.type) };
    case 'ZodOptional':
      // Optional fields are handled at the parent z.object level by
      // omitting from `required`. When optional shows up at top-level,
      // surface its inner type (the optional-ness is documented but
      // not modelable in standalone JSON Schema).
      return zodToJsonSchema(def.innerType);
    case 'ZodNullable':
      return { ...zodToJsonSchema(def.innerType), nullable: true };
    case 'ZodAny':
    case 'ZodUnknown':
      return {};
    case 'ZodRecord':
      return { type: 'object', additionalProperties: zodToJsonSchema(def.valueType) };
    case 'ZodObject': {
      const shape = (def.shape as () => Record<string, ZodTypeAny>)();
      const properties: JsonSchema = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(child);
        if (!isOptional(child)) required.push(key);
      }
      const out: JsonSchema = { type: 'object', properties };
      if (required.length > 0) out.required = required;
      return out;
    }
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = def.options as ZodTypeAny[];
      return { oneOf: options.map((o) => zodToJsonSchema(o)) };
    }
    case 'ZodIntersection':
      return {
        allOf: [zodToJsonSchema(def.left), zodToJsonSchema(def.right)],
      };
    default:
      // Unhandled — surface a loose `any` rather than throwing so
      // schema additions don't break the spec endpoint.
      return {};
  }
}

function isOptional(schema: ZodTypeAny): boolean {
  return schema._def.typeName === 'ZodOptional';
}

// Re-export z for callers that want to extend our schemas.
export { z };

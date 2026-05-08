/**
 * Zod schemas for edge-memory-server's REST surface (PRD F11).
 *
 * Canonical source of truth for request + response shapes. The
 * OpenAPI 3.1 generator at `openapi.ts` derives the spec from these
 * — when the schemas change, the spec changes.
 *
 * Note: handlers in `index.ts` still use ad-hoc validation as of v1
 * (those landed before F11). Migrating them to `schema.parse()` is
 * a refactor for a follow-up slice; the spec generation only needs
 * these schemas to be accurate, not to be wired into every code path.
 */

import { z } from 'zod';

export const MemoryScopeSchema = z
  .object({
    jobId: z.string().optional(),
    productId: z.string().optional(),
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    organizationId: z.string().optional(),
    topic: z.string().optional(),
  })
  .describe('PRD F3 scope dimensions; AND-combined when multiple set.');

export const FeedbackSourceSchema = z.enum([
  'hitl-approval',
  'hitl-rejection',
  'phase-success',
  'phase-failure',
  'pr-merged',
  'pr-rejected',
  'tests-passed',
  'tests-failed',
  'rollback',
  'manual',
  'agent-self-eval',
]);

export const MemoryProvenanceSchema = z.object({
  originatingJobId: z.string().optional(),
  originatingProductId: z.string().optional(),
  consolidatedFrom: z
    .object({
      scope: MemoryScopeSchema,
      entryIds: z.array(z.string()),
    })
    .optional(),
  consolidatedBy: z.enum(['rule', 'summary', 'manual']).optional(),
  consolidatedAt: z.string().optional(),
  feedback: z.enum(['positive', 'negative', 'unconfirmed']),
  feedbackSource: FeedbackSourceSchema.optional(),
  feedbackAt: z.string().optional(),
});

export const MemoryEntrySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  key: z.string(),
  value: z.any(),
  scope: MemoryScopeSchema,
  provenance: MemoryProvenanceSchema,
});

export const MemoryQuerySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('structured'),
    key: z.string().optional(),
    scope: MemoryScopeSchema.optional(),
  }),
  z.object({
    kind: z.literal('recent'),
    scope: MemoryScopeSchema.optional(),
    limit: z.number().optional(),
  }),
  z.object({
    kind: z.literal('similarity'),
    q: z.string(),
    scope: MemoryScopeSchema.optional(),
    topK: z.number().optional(),
  }),
  z.object({
    kind: z.literal('graph'),
    from: z.string(),
    depth: z.number().optional(),
  }),
]);

export const MemoryQueryResultSchema = z.union([
  z.object({
    kind: z.literal('ok'),
    entries: z.array(MemoryEntrySchema),
  }),
  z.object({
    kind: z.literal('unsupported'),
    reason: z.string(),
  }),
]);

export const PutInputSchema = z.object({
  key: z.string(),
  value: z.any(),
  scope: MemoryScopeSchema.optional(),
  provenance: MemoryProvenanceSchema.optional(),
});

export const MemoryForgetPredicateSchema = z.object({
  scope: MemoryScopeSchema.optional(),
  key: z.string().optional(),
  olderThan: z.string().optional(),
  id: z.string().optional(),
  feedback: z.enum(['unconfirmed', 'positive', 'negative']).optional(),
});

export const MemoryForgetResultSchema = z.object({
  deleted: z.number(),
  deletedIds: z.array(z.string()),
});

export const MemoryTagInputSchema = z.object({
  entryIds: z.array(z.string()).optional(),
  scope: MemoryScopeSchema.optional(),
  key: z.string().optional(),
  olderThan: z.string().optional(),
  feedback: z.enum(['positive', 'negative']),
  feedbackSource: FeedbackSourceSchema.optional(),
  overwrite: z.boolean().optional(),
});

export const MemoryTagResultSchema = z.object({
  tagged: z.number(),
  alreadyTagged: z.number(),
  taggedIds: z.array(z.string()),
});

export const ConsolidateInputSchema = z.object({
  from: z.object({ scope: MemoryScopeSchema }),
  to: z.object({ scope: MemoryScopeSchema }),
  strategy: z
    .enum(['feedback-required', 'feedback-by-topic', 'feedback-summarize', 'include-all'])
    .optional(),
  feedbackFilter: z.array(z.enum(['positive', 'negative'])).optional(),
  topic: z.string().optional(),
  keepSource: z.boolean().optional(),
});

export const ConsolidateResultSchema = z.object({
  promoted: z.number(),
  skipped: z.number(),
  summarizedFrom: z.number().optional(),
  lineageIds: z.array(z.string()),
  feedbackBreakdown: z.object({ positive: z.number(), negative: z.number() }),
});

export const SnapshotInputSchema = z.object({
  scope: MemoryScopeSchema,
});

export const SnapshotResultSchema = z.object({
  snapshotId: z.string(),
  count: z.number(),
  createdAt: z.string(),
});

export const RestoreInputSchema = z.object({
  snapshotId: z.string(),
  mode: z.enum(['replace', 'merge']).optional(),
});

export const RestoreResultSchema = z.object({
  restored: z.number(),
  mode: z.enum(['replace', 'merge']),
  snapshotId: z.string(),
});

export const InspectInputSchema = z.object({
  scope: MemoryScopeSchema.optional(),
  showLineage: z.boolean().optional(),
});

export const InspectResultSchema = z.object({
  totalEntries: z.number(),
  byFeedback: z.object({
    positive: z.number(),
    negative: z.number(),
    unconfirmed: z.number(),
  }),
  byScope: z.object({
    jobIds: z.record(z.number()),
    productIds: z.record(z.number()),
    userIds: z.record(z.number()),
    sessionIds: z.record(z.number()),
    organizationIds: z.record(z.number()),
    topics: z.record(z.number()),
  }),
  lineage: z.array(z.any()).optional(),
});

export const ImportResultSchema = z.object({
  imported: z.number(),
  errors: z.array(z.object({ line: z.number(), error: z.string() })),
});

export const HealthResponseSchema = z.object({
  service: z.literal('memory'),
  state: z.enum(['warm', 'idle']),
  uptimeMs: z.number(),
  backend: z.string(),
  entryCount: z.number(),
  ts: z.string(),
});

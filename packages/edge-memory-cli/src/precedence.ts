/**
 * Read/write precedence chains (PRD F3a/F3b) — when the agent runs
 * `edge-memory query` or `edge-memory put` without an explicit
 * --scope, the harness env supplies the scope context. F3a/F3b say:
 *
 *   F3a (read): walk the chain narrow→wide; return the first scope
 *               that has matches. With mode='union', union all hits.
 *               Order: jobId → productId → userId → organizationId → topic.
 *
 *   F3b (write): write to the narrowest available scope. Order:
 *                jobId → sessionId → productId → userId → organizationId → topic.
 *
 * Env shape: harness-server worker exports JOB_ID, PRODUCT_ID, USER_ID,
 * SESSION_ID, ORG_ID, TOPIC into the worker's shell environment. Per
 * PRD § 4.4 SKILL.md.
 *
 * This module is purely CLI-side — the server stays scope-agnostic.
 * No server changes needed for F3a/F3b.
 */

import type { MemoryScope } from '@ecruz165/edge-memory-server';

/** Read a single env var that the worker exports. Empty string is
 *  treated as unset (matches typical shell-env semantics). */
function envScope(env: Record<string, string | undefined>): {
  jobId?: string;
  productId?: string;
  userId?: string;
  sessionId?: string;
  organizationId?: string;
  topic?: string;
} {
  const out: ReturnType<typeof envScope> = {};
  if (env.JOB_ID) out.jobId = env.JOB_ID;
  if (env.PRODUCT_ID) out.productId = env.PRODUCT_ID;
  if (env.USER_ID) out.userId = env.USER_ID;
  if (env.SESSION_ID) out.sessionId = env.SESSION_ID;
  if (env.ORG_ID) out.organizationId = env.ORG_ID;
  if (env.TOPIC) out.topic = env.TOPIC;
  return out;
}

/**
 * F3b — pick the narrowest scope from env. Returns undefined if no
 * env scope keys are set (caller should fall back to "no scope" /
 * global).
 *
 * Order (narrow→wide): jobId → sessionId → productId → userId →
 * organizationId → topic. The PRD's prose calls out jobId then
 * sessionId then "next available" — we make the rest explicit so
 * the rule is mechanical, not interpretive.
 */
export function narrowestScope(env: Record<string, string | undefined>): MemoryScope | undefined {
  const e = envScope(env);
  if (e.jobId) return { jobId: e.jobId };
  if (e.sessionId) return { sessionId: e.sessionId };
  if (e.productId) return { productId: e.productId };
  if (e.userId) return { userId: e.userId };
  if (e.organizationId) return { organizationId: e.organizationId };
  if (e.topic) return { topic: e.topic };
  return undefined;
}

/**
 * F3a — return the read-chain: ordered list of scopes from narrow to
 * wide that the CLI should try in succession. First non-empty result
 * wins. Empty list when no env scope keys are set.
 *
 * Order (per PRD F3a): jobId → productId → userId → organizationId →
 * topic. (sessionId is NOT in the read chain — read precedence is
 * about cross-session sharing; sessionId is a write-narrowness key
 * only.)
 */
export function readChain(env: Record<string, string | undefined>): MemoryScope[] {
  const e = envScope(env);
  const out: MemoryScope[] = [];
  if (e.jobId) out.push({ jobId: e.jobId });
  if (e.productId) out.push({ productId: e.productId });
  if (e.userId) out.push({ userId: e.userId });
  if (e.organizationId) out.push({ organizationId: e.organizationId });
  if (e.topic) out.push({ topic: e.topic });
  return out;
}

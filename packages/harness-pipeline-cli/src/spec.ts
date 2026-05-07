/**
 * JobSpec — the assembler/executor contract between harness-server and
 * harness-pipeline.
 *
 * Per memory `project_proxy_per_job_architecture`:
 *   - harness-server is the *assembler* (always-on, reads catalog + auth.json,
 *     resolves accept-list bindings, projects per-job set, writes spec.json)
 *   - harness-pipeline is the *executor* (per-job, reads spec.json, runs
 *     runJob, exits)
 *
 * The spec is the seam. Everything the executor needs is in here, and nothing
 * else — particularly NOT the user's auth.json (only resolved credentials per
 * agent are embedded), NOT the catalog (just this job's resolved agent list),
 * NOT the env vars (env-strip discipline preserved by topology).
 *
 * Versioning: `version: 1` is the v1 schema. Schema evolution adds new
 * required fields under a bumped version; readers reject unknown versions
 * with an actionable error rather than silently ignoring fields.
 */

import type { ResolvedBinding } from '@ecruz165/agent-auth';
import type { AdapterId } from '@ecruz165/harness-core';

/**
 * One agent's pre-resolved description, ready for orchestration.
 *
 * Fields mirror RegisteredAgent (from harness-core) but with `accepts`
 * already projected to a flat list at submission time. The `bindingId` is
 * the key into spec.bindings; harness-pipeline looks it up there to find
 * the resolved provider/model/credential.
 */
export interface SpecAgent {
  id: string;
  role: string;
  adapter: AdapterId;
  systemPrompt?: string;
  config?: Record<string, unknown>;
  /** Key into spec.bindings; absent for agents with no model binding (e.g.,
   *  legacy agents that go through adapterFactory without resolution). */
  bindingId?: string;
}

/**
 * Top-level JobSpec. Written by harness-server to
 * `<workspace>/.harness/run/jobs/<jobId>/spec.json` (mode 0600), read by the
 * harness-pipeline runtime on container boot.
 */
export interface JobSpec {
  version: 1;
  jobId: string;
  pipeline?: string;
  productId?: string;
  productRepos?: string[];
  name?: string;
  input?: string;
  /** Job submission's `set` field, after defaulting to `'default'`.
   *  Informational — accepts are already projected at this point. */
  set: string;
  /** The full agent list for this job, in execution order. Includes the
   *  synthetic coordinator (prepended) and checkout-coordinator (appended)
   *  if the job is pipeline-bound; harness-server does that injection. */
  agents: SpecAgent[];
  /** Pre-resolved bindings keyed by `bindingId` (typically the agent id).
   *  Each entry carries the credential the adapter needs — the executor
   *  never reads auth.json. */
  bindings: Record<string, ResolvedBinding>;
}

/** Thrown when spec.json is malformed or carries an unsupported version. */
export class JobSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobSpecError';
  }
}

/**
 * Parse-and-validate a JobSpec from raw JSON. Strict: unknown version,
 * missing required fields, or wrong types throw `JobSpecError` with a
 * specific message. The executor calls this once on boot and refuses to
 * proceed on failure (no partial-spec orchestration).
 */
export function parseJobSpec(raw: unknown, source = 'spec.json'): JobSpec {
  if (!raw || typeof raw !== 'object') {
    throw new JobSpecError(`${source}: top-level must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new JobSpecError(
      `${source}: unsupported version ${JSON.stringify(obj.version)} (this executor handles version 1)`,
    );
  }
  if (typeof obj.jobId !== 'string' || !obj.jobId) {
    throw new JobSpecError(`${source}: jobId must be a non-empty string`);
  }
  if (typeof obj.set !== 'string' || !obj.set) {
    throw new JobSpecError(`${source}: set must be a non-empty string`);
  }
  if (!Array.isArray(obj.agents)) {
    throw new JobSpecError(`${source}: agents must be an array`);
  }
  if (!obj.bindings || typeof obj.bindings !== 'object') {
    throw new JobSpecError(`${source}: bindings must be an object`);
  }
  const bindings = obj.bindings as Record<string, unknown>;
  for (const [i, a] of obj.agents.entries()) {
    if (!a || typeof a !== 'object') {
      throw new JobSpecError(`${source}: agents[${i}] must be an object`);
    }
    const agent = a as Record<string, unknown>;
    if (typeof agent.id !== 'string' || !agent.id) {
      throw new JobSpecError(`${source}: agents[${i}].id must be a non-empty string`);
    }
    if (typeof agent.role !== 'string' || !agent.role) {
      throw new JobSpecError(`${source}: agents[${i}].role must be a non-empty string`);
    }
    if (agent.adapter !== 'claude-sdk' && agent.adapter !== 'opencode-cli') {
      throw new JobSpecError(
        `${source}: agents[${i}].adapter must be "claude-sdk" or "opencode-cli"`,
      );
    }
    // bindingId is optional; if present, it must reference a real binding.
    if (agent.bindingId !== undefined) {
      if (typeof agent.bindingId !== 'string' || !agent.bindingId) {
        throw new JobSpecError(
          `${source}: agents[${i}].bindingId must be a non-empty string when present`,
        );
      }
      if (!(agent.bindingId in bindings)) {
        throw new JobSpecError(
          `${source}: agents[${i}].bindingId "${agent.bindingId}" not present in bindings map`,
        );
      }
    }
  }
  return obj as unknown as JobSpec;
}

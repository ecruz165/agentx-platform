import type { AdapterId, FlowDef } from './catalog.ts';

export type AgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Per-call token usage: input ("provided", what was sent to the LLM)
 * + output ("emitted", what the LLM returned). One pair per LLM
 * round-trip. Adapters report these via `TokenUsage` on their
 * `response` events; `TokenAccumulator` is the consumer that turns
 * the event stream into per-agent + per-job totals on the JobRecord.
 *
 * Sum semantics: `out` adds cleanly across calls. `in` does NOT —
 * provider APIs report `prompt_tokens` as the FULL context sent THIS
 * call (which on multi-turn agents includes prior turns
 * reaccumulated). Adding `in` across a multi-turn agent overcounts
 * the actual context size; it accurately represents BILLED input
 * tokens. Renderers should label this honestly ("billed" not
 * "context").
 */
export interface AgentTokens {
  readonly in: number;
  readonly out: number;
}

export interface RegisteredAgent {
  id: string;
  role: string;
  adapter: AdapterId;
  systemPrompt?: string;
  status: AgentStatus;
  /**
   * Adapter-specific config copied from AgentDef.config when the job is
   * registered. Passed through to the adapter factory at invoke time.
   */
  config?: Record<string, unknown>;
  /**
   * Priority-ordered `<provider>:<model>` accept-list copied from
   * AgentDef.accepts when the job is registered. When present, the
   * orchestrator routes through BindingResolver + bindingToAdapter
   * instead of the legacy `adapter` factory dispatch. Optional for
   * backwards compatibility — agents declared without `accepts` fall
   * through to the existing `adapter`-id-based factory.
   */
  accepts?: readonly string[];
  /**
   * Per-call token usage history. One entry per `response` event with
   * `usage` that the agent emitted. Empty/undefined for not-yet-
   * invoked agents and for agents whose adapters never reported usage
   * (e.g., loaders, future synthetic agents).
   *
   * Mutated in place by `TokenAccumulator` as `response` events flow
   * across the JobBus. Persistence layers (sqlite/postgres) should
   * treat this as an in-flight mutable field, not append-only after
   * job completion.
   */
  tokenHistory?: AgentTokens[];
  /**
   * Running per-agent total — `tokenHistory.reduce(sum)`. Maintained
   * eagerly by `TokenAccumulator` so reads (API serialization, TUI
   * render) don't have to recompute. See `AgentTokens` doc for sum
   * semantics caveat.
   */
  tokens?: AgentTokens;
  /**
   * Per-agent runtime-fallback policy. Names of `AdapterError`
   * subclasses (matched against `error.name`) that should trigger
   * fall-through to the next satisfiable binding when the current
   * binding throws.
   *
   * Unset → defaults to {@link DEFAULT_FALLBACK_ERRORS}: the recoverable
   * subset (BillingError, RateLimitError, NetworkError, ProviderError).
   * AuthError and ConfigError are intentionally excluded from the
   * default — both signal a structurally broken binding that needs
   * human action (re-auth, fix catalog) rather than silent retry.
   *
   * Override examples:
   *   - `['BillingError']` — only fall through on credit/quota issues
   *   - `['BillingError', 'RateLimitError', 'AuthError']` — also retry
   *     across providers when one's auth fails
   *   - `[]` — never fall back; the first binding's failure is terminal
   *
   * Per slice 13c (`project_per_worker_model_subscription`-aware
   * runtime fallback). Copied from AgentDef.fallbackOn at job
   * registration.
   */
  fallbackOn?: readonly string[];
}

export interface JobRecord {
  jobId: string;
  pipeline?: string;
  productId?: string;
  productRepos?: string[];
  name?: string;
  input?: string;
  submittedAt: string;
  status: string;
  agents: RegisteredAgent[];
  /**
   * The compiled flow that defines this job's execution graph. Optional
   * for backwards compatibility — every JobRecord submission today
   * provides agents directly (a flat list); runJob synthesizes a linear
   * FlowDef from that list when this field is absent. New callers
   * (Phase 4+) attach the canonical FlowDef from the catalog so the
   * graph executor can honor non-linear topology, edge kinds, and tags.
   *
   * Not persisted across server restarts in the in-memory job map; if a
   * future SQLite/Postgres backend stores JobRecords, the flow can be
   * looked up by id from the catalog rather than serialized inline.
   */
  flow?: FlowDef;
  /**
   * Filesystem root under which this job's product repos live. Each
   * repo in `productRepos` is expected at `<workdirRoot>/<repoName>`.
   * Used by the agent executor (and harness-server file routes) to
   * discover staged changes via `git diff --cached` and to serve file
   * content to HITL reviewers.
   *
   *   - in-process runJob: harness-server sets this to its workspaceRoot
   *     so the agent's working directory IS the workspace's clones.
   *   - container runJobInContainer: per-job worktree path
   *     (`<workspaceRoot>/.harness/wt/<jobId>`) — each job gets isolated
   *     working trees rather than sharing the developer's clones.
   *
   * Optional — when absent, change discovery silently returns no
   * entries (useful for tests and registration-only mode where there's
   * no real filesystem to scan).
   */
  workdirRoot?: string;
  /**
   * Job-level cumulative tokens — sum of every agent's running total.
   * Maintained eagerly by `TokenAccumulator` so the API and TUI can
   * read without recomputation. See `AgentTokens` doc for sum
   * semantics: input numbers are billed-tokens not context-size.
   */
  tokens?: AgentTokens;
  /**
   * Gate 2 — GitHub delivery metadata, written by `publish` FlowDef
   * nodes as their node output flows back into job state:
   *   - `push-and-open-pr` sets `branchName` + `prUrl`
   *   - `merge-pr` sets `mergeSha` once the approved PR is merged
   * Absent for jobs whose flows don't include a `publish` node (e.g.
   * analysis-only jobs, or flows that deliver via S3/Figma instead).
   */
  branchName?: string;
  prUrl?: string;
  mergeSha?: string;
  [key: string]: unknown;
}

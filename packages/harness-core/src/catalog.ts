import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The pipeline catalog declares which pipelines the harness knows about and,
 * for each, the steps that compose it. Per the authority memory, the catalog
 * is admin-owned: clients submit *intent* (a pipeline id + input), they do not
 * design pipelines.
 *
 * Local layout: `.harness/config/pipelines.json` at the workspace root. When
 * the central Spring Modulith Catalog service lands, this loader is replaced
 * by an HTTP/gRPC call behind the same `loadCatalog()` surface.
 *
 * TODO(you): the catalog shape is intentionally minimal — extend with the
 * fields your pipelines actually need. Likely additions:
 *   - per-agent `model` override (today the adapter picks its default)
 *   - per-agent `timeoutMs`, `maxRetries`, `temperature`
 *   - tool/skill bindings (which MCP servers each agent may call)
 *   - `dependsOn: string[]` for fan-in / fan-out within a pipeline
 *   - `inputSchema` / `outputSchema` for inter-agent message contracts
 * Add these as you encounter the need; keeping fields out until they have a
 * concrete consumer prevents catalog-as-config drift.
 */
export type AdapterId = 'claude-sdk' | 'opencode-cli';

export interface AgentDef {
  /** Stable id for streaming/registration. Unique within a pipeline. */
  id: string;
  /** Human-readable label (TUI middle column, logs). */
  role: string;
  /** Which adapter implementation runs this agent. */
  adapter: AdapterId;
  /** Optional system prompt; if omitted, the adapter's default applies. */
  systemPrompt?: string;
  /**
   * Optional adapter-specific configuration. Passed through to the adapter
   * factory; the adapter is responsible for interpreting the shape. Use this
   * for per-agent overrides like model name, endpoint URL (for opencode-cli
   * with a self-hosted backend), reasoning effort, timeout, etc.
   */
  config?: Record<string, unknown>;
  /**
   * Priority-ordered list of `<provider>:<model>` bindings this agent will
   * accept. Per project memory `project_per_worker_model_subscription`, the
   * harness-server resolves this list against the configured AuthStore /
   * Secrets Manager + the LLMProvider registry at spawn time and binds the
   * agent to the first satisfiable entry. Mixed cloud+local pipelines are
   * the natural payoff: a summarizer can lead with `local-qwen:qwen3` while
   * a code-reviewer holds out for `anthropic:claude-haiku-4-5`.
   *
   * Two equivalent shapes (per memory `project_set_scoped_accepts`):
   *
   *   1. Flat array: `["anthropic:claude-haiku-4-5", "local-qwen:qwen3"]`
   *      — single global priority list. Treated as `{default: [...]}`.
   *
   *   2. Named sets: `{ default: [...], cheap: [...], frontier: [...],
   *      bench-claude: [...], bench-gpt: [...] }` — pick one set per-job
   *      via the `set` field on the job submission. Falls back to
   *      `default` when the active set isn't declared on this agent.
   *      Selecting per-job (not per-server) lets a single running harness
   *      serve different sets concurrently — natural for benchmarking
   *      and per-customer policy.
   *
   * Validation is structural only (each leaf entry must be a non-empty
   * `<provider>:<model>` string). Whether each entry actually exists in
   * the registry is checked at resolve time.
   *
   * Use `resolveAccepts(agent, setName)` to project to a flat list. The
   * orchestrator does this when registering agents for a job.
   */
  accepts?: readonly string[] | Readonly<Record<string, readonly string[]>>;
  /**
   * Per-agent runtime-fallback policy. Names of `AdapterError` subclasses
   * (matched against `error.name`) that should trigger fall-through to
   * the next satisfiable binding when the current binding throws.
   *
   * Unset → uses the default recoverable set (BillingError,
   * RateLimitError, NetworkError, ProviderError). AuthError + ConfigError
   * are excluded by default because they signal structural problems
   * (revoked key, missing model) — silent retry across providers is
   * usually the wrong action; surface to the operator instead.
   *
   * Set to `[]` to disable fallback entirely for this agent (any error
   * is terminal, even if other accept-list entries are satisfiable).
   *
   * Per slice 13c per-agent customization: catalog authors who want
   * "never silently switch providers when an auth error occurs"
   * default behavior get it for free; pipelines that explicitly want
   * cross-provider auth retry opt in via `fallbackOn: [...,
   * 'AuthError']`.
   */
  fallbackOn?: readonly string[];
  /**
   * Skills this agent depends on. References items from the
   * `@ecruz165/skillzkit` catalog — the procurement flow (workspace-cli)
   * resolves each entry to markdown files + transitive dependencies and
   * copies them into `<workspace>/.claude/{commands,skills}/` so the
   * agent can invoke them at runtime.
   *
   * skillzkit's catalog has two top-level types: SKILLs (router agents
   * that classify natural-language requests + dispatch to commands) and
   * Commands (everything else — slash commands, workflows, tools,
   * integrations, atomic tasks). The categories below mirror that split
   * plus skillzkit's sub-classification under `.claude/commands/`:
   *
   *   - `routers`      — SKILL names (router agents). Lookup by name
   *                       (e.g. `skillzkit-product-router`)
   *   - `tools`        — local CLIs / utilities (e.g. `core:tools:npm`,
   *                       `core:tools:gh`, `core:tools:jq`)
   *   - `integrations` — remote services the agent connects to (e.g.
   *                       `core:integrations:figma`, `core:integrations:linear`)
   *   - `tasks`        — atomic action commands (smaller unit than workflow)
   *   - `workflows`    — multi-step procedures from skillzkit's Workflow
   *                       catalog (e.g. `engineer:feature-build`,
   *                       `product:greenfield`)
   *
   * Validation here is structural only — string non-emptiness + a closed
   * key set. Whether each slug or skill name actually exists in the
   * installed skillzkit catalog is checked at procure time by the
   * workspace-cli, not at catalog parse time (so a catalog can reference
   * skills that aren't yet installed).
   *
   * Skipping this field is fine — agents without skill dependencies don't
   * need any `.claude/` content beyond what the workspace-template ships.
   */
  skillz?: {
    routers?: readonly string[];
    tools?: readonly string[];
    integrations?: readonly string[];
    tasks?: readonly string[];
    workflows?: readonly string[];
  };
}

// ─── Flow taxonomy (v1 — graph + tags) ───────────────────────────────────
//
// One node primitive (TaskStep), polymorphic via `kind`. Edges carry all
// routing logic. Behavioral modifiers are tags (Approval, Suspend, Loop).
// Reliability concerns are policies. The graph maps 1:1 to LangGraph node
// + conditional-edge execution.
//
// Spec: `.plans/flow-designer-spec-v1.0.md` (canonical reference).
//
// What's NOT in v1:
//   - No `if`, `loop`, `try`, `fork`, `map` step kinds. All replaced by
//     edges (conditional, parallel split/join, error, fallback, reject)
//     and tags (Loop iterates a single node over a collection).
//   - No `fail` / `succeed` step kinds. Terminal nodes are nodes with
//     no outgoing edges; their `terminal` field defaults to 'success'.

/**
 * The single canvas primitive — every node on the flow graph is a TaskStep.
 * Polymorphic via the `kind` discriminator; per-kind config goes in `config`,
 * tags add behavioral modifiers, policy controls reliability, joinStrategy
 * defines how multiple incoming edges combine.
 */
export interface TaskStep {
  /** Stable id; referenced by edges. Unique within a flow. */
  id: string;
  /** Polymorphic discriminator. */
  kind: 'agent' | 'tool' | 'script' | 'transform' | 'gate' | 'subflow' | 'trigger';
  /** Per-kind config (typed by which kind is set). */
  config:
    | AgentConfig
    | ToolConfig
    | ScriptConfig
    | TransformConfig
    | GateConfig
    | SubflowConfig
    | TriggerConfig;
  /** Behavioral modifier tags. Multiple allowed; render order is
   *  Loop top-left, Approval/Suspend top-right. Approval and Suspend
   *  are mutually exclusive on the same node. */
  tags?: TaskStepTags;
  /** Reliability policy. */
  policy?: TaskStepPolicy;
  /** Strategy for combining multiple incoming edges. Default 'all'. */
  joinStrategy?: 'all' | 'any' | { nOfM: number };
  /** Set on nodes with no outgoing edges. Defaults to 'success'. */
  terminal?: 'success' | 'fail';
}

// ─── Per-kind configs ────────────────────────────────────────────────────

/** LLM-driven execution. The dominant kind. */
export interface AgentConfig {
  agent: AgentDef;
}

/** Deterministic tool/API call. References a tool by id (resolved against
 *  the tool catalog or skillzkit). */
export interface ToolConfig {
  toolId: string;
  args?: Record<string, unknown>;
}

/** Code execution. */
export interface ScriptConfig {
  language: 'bash' | 'node' | 'python';
  source: string;
  env?: Record<string, string>;
}

/** Pure data shaping. Evaluates an expression against current flow state. */
export interface TransformConfig {
  expression: Expression;
}

/** Quality gate. Runs assertions; emits 'pass' (sequence edge) or 'reject'
 *  (reject edge) based on whether all assertions hold. */
export interface GateConfig {
  assertions: Assertion[];
}

export interface Assertion {
  expression: Expression;
  /** Human-readable message embedded in the rejection payload when this
   *  assertion fails. */
  message: string;
}

/** Invoke another flow as a sub-flow. The parent pauses until the
 *  sub-flow terminates; sub-flow output flows in as this node's output. */
export interface SubflowConfig {
  flowId: string;
  input?: Record<string, unknown>;
}

/** Entry point. Exactly one trigger node per flow. */
export type TriggerConfig =
  | { kind: 'webhook'; path: string; method?: 'GET' | 'POST' }
  | { kind: 'schedule'; cron: string; tz?: string }
  | { kind: 'manual' }
  | { kind: 'event'; eventType: string; matcher?: Expression }
  | { kind: 'message'; channel: string };

// ─── Tags (behavioral modifiers) ─────────────────────────────────────────

export interface TaskStepTags {
  approval?: ApprovalTag;
  suspend?: SuspendTag;
  loop?: LoopTag;
}

/** HITL gate. Pauses execution; assigns to a role; injects steering
 *  context on retry. Emits both 'sequence' (approve) and 'reject' edges. */
export interface ApprovalTag {
  /** Org role authorized to approve (e.g., 'tech-lead', 'security-team'). */
  assigneeRole: string;
  /** Time before the approval auto-rejects. */
  slaMs: number;
  /** Optional structured input the reviewer fills in to steer retry. */
  steeringInputs?: SteeringInputSchema;
  /** Concurrency: only 'pessimistic' (single approver locks) in v1. */
  concurrency: 'pessimistic';
}

export interface SteeringInputSchema {
  fields: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean';
    required?: boolean;
  }>;
}

/** Durable execution checkpoint. Serializes state, kills the worker,
 *  hydrates a new worker on timer expiration or external signal. */
export type SuspendTag =
  | { trigger: { kind: 'timer'; durationMs: number } }
  | { trigger: { kind: 'event'; eventType: string; matcher?: Expression } };

/** Iterates the same node over a collection. Composes with anything;
 *  Loop+Approval = approval per iteration; Loop+Suspend = durable
 *  iteration checkpoint. */
export interface LoopTag {
  /** Hint about what kind of iterable `path` resolves to. The runtime
   *  uses this to pick a default collector (e.g., 'directory' walks
   *  files; 'collection' iterates an array). */
  source: 'collection' | 'directory';
  /** Expression resolving to the iterable. May reference flow state,
   *  product repos, prior node output, etc. */
  path: Expression;
  /** Sequential = one iteration at a time; parallel = N at once. */
  mode: 'sequential' | 'parallel';
  /** Cap on concurrent iterations when `mode: 'parallel'`. */
  concurrency?: number;
}

// ─── Policy (reliability config; not topology) ───────────────────────────

export interface TaskStepPolicy {
  retry?: RetryPolicy;
  timeout?: Duration;
  /** Behavior when an unhandled error occurs:
   *   - 'propagate' (default) — fail the flow
   *   - 'continue' — log and proceed past this node
   *   - 'fallback' — route to the node's fallback edge if present */
  onError?: 'propagate' | 'continue' | 'fallback';
}

export interface RetryPolicy {
  maxAttempts: number;
  backoff?: BackoffPolicy;
}

export type BackoffPolicy =
  | { kind: 'fixed'; ms: number }
  | { kind: 'exponential'; baseMs: number; maxMs?: number; multiplier?: number };

/** Milliseconds. */
export type Duration = number;

// ─── Edges (carry all routing logic) ─────────────────────────────────────

export type Edge = SequenceEdge | ConditionalEdge | FallbackEdge | ErrorEdge | RejectEdge;

export interface SequenceEdge {
  from: string;
  to: string;
  type: 'sequence';
}

export interface ConditionalEdge {
  from: string;
  to: string;
  type: 'conditional';
  condition: Expression;
}

export interface FallbackEdge {
  from: string;
  to: string;
  type: 'fallback';
}

export interface ErrorEdge {
  from: string;
  to: string;
  type: 'error';
}

/** Emitted only by Approval-tagged nodes and `kind: 'gate'` nodes when
 *  they reject. Carries a structured rejection payload (steering context,
 *  findings, attempt counter). The reject edge is the only edge that may
 *  form a cycle (retry-with-context loops). */
export interface RejectEdge {
  from: string;
  to: string;
  type: 'reject';
  /** Default 3. */
  maxAttempts?: number;
  /** Where to go when maxAttempts is exceeded. Default: fail the flow. */
  onMaxAttempts?: { kind: 'fail' } | { kind: 'escalate'; to: string };
}

/** The runtime payload carried by reject edges. Becomes input context
 *  to the destination node. */
export interface RejectionPayload {
  reason: string;
  /** Reviewer-injected hints (Approval) or assertion-failure message (gate). */
  steering?: string;
  /** Structured gate output. */
  findings?: unknown;
  /** 1-indexed; incremented each loop iteration. */
  attempt: number;
}

// ─── Expression (predicates + iterable resolution) ───────────────────────

/** Generic expression evaluated by the runtime. Tagged-union over evaluators
 *  so we can grow the language additively. */
export type Expression =
  /** JSONPath against flow state, e.g. `{ kind: 'jsonpath', path: '$.input.repos' }`. */
  | { kind: 'jsonpath'; path: string }
  /** Sandboxed JS, e.g. `{ kind: 'js', expression: 'ctx.review.score > 0.8' }`. */
  | { kind: 'js'; expression: string }
  /** Constant value. */
  | { kind: 'literal'; value: unknown };

// ─── FlowOutputContract (drives JobIntent emission semantics) ────────────

/** Output contract for a flow. Drives validator (e.g., a
 *  `kind: 'job-definition'` flow must declare `output.kind: 'job-intent'`)
 *  and JobStateMachine emission semantics (terminal node output is parsed
 *  against this shape). */
export type FlowOutputContract =
  /** Default for `kind: 'work'` — plain agent text response. */
  | { kind: 'agent-text' }
  /** Required for `kind: 'job-definition'` — terminal node emits a JobIntent. */
  | { kind: 'job-intent' }
  /** Fan-out meta-flows emitting an array of JobIntents. */
  | { kind: 'job-intents'; min?: number; max?: number }
  /** Spec-emitting flows (e.g. `flow-architect`). */
  | { kind: 'flow-spec' }
  /** Generalized typed output. */
  | { kind: 'structured'; schema: unknown };

/** The runtime representation of a JobIntent — what JobDefinitionFlows
 *  emit, what gets submitted to JobStateMachine to launch the actual
 *  work flow. */
export interface JobIntent {
  flowId: string;
  productId: string;
  input: unknown;
  /** Optional: which named accepts-set to use ('default', 'cheap',
   *  'frontier', 'bench-claude', etc.). */
  set?: string;
  /** Per-job overrides (e.g., timeout). Adapter-specific. */
  config?: Record<string, unknown>;
}

// ─── FlowDef ─────────────────────────────────────────────────────────────

export interface FlowDef {
  id: string;
  description?: string;
  /**
   * Flow kind discriminator. Default 'work'.
   *   - 'work' (default) — does product work; agents run for end-user value.
   *   - 'job-definition' — emits a JobIntent (intake conversations).
   *     Must declare `output: { kind: 'job-intent' }`.
   *   - 'post-job' — runs after a job for cleanup/notifications.
   */
  kind?: 'work' | 'job-definition' | 'post-job';
  /** Output contract for the terminal node. Default for `kind: 'work'`
   *  is `{ kind: 'agent-text' }`. JobDefinitionFlows MUST declare
   *  `{ kind: 'job-intent' }`. */
  output?: FlowOutputContract;
  /** All nodes (TaskSteps) in this flow. Exactly one must have
   *  `kind: 'trigger'` (the entry point). */
  nodes: TaskStep[];
  /** All edges between nodes. Routing logic lives here. */
  edges: Edge[];
}

/**
 * Walk a flow's nodes; yield every AgentDef from `kind: 'agent'` nodes.
 * Useful for surfaces that need a flat agent list — token-counting,
 * capability preflight, "register every agent for this job".
 */
export function* walkAgents(flow: FlowDef): Generator<AgentDef> {
  for (const node of flow.nodes) {
    if (node.kind === 'agent') {
      yield (node.config as AgentConfig).agent;
    }
  }
}

/**
 * One context-source declaration on a product. Mirrors the shape used in
 * `<workspace>/.harness/config/context-sources.yml` and in
 * harness-workspace.yml's per-product `contextSources` block. The loader
 * consumes these one-per-spawned-worker when `harness context load
 * --product X` lands.
 */
export interface ContextSourceDef {
  /** Source-type id from @ecruz165/context-loader-core's catalog
   *  (`code-full`, `prose-markdown`, `oss-code`, …). */
  type: string;
  /** What to ingest: a path, an OSS package@version, or a URL. */
  target: string;
  /** Per-source overrides (winning over workspace defaults). */
  embedderUrl?: string;
  embedderModel?: string;
  embedderDim?: number;
  backend?: string;
}

/**
 * One product repo declaration — name + git clone URL + optional
 * baseRef + optional in-container mount path. Used by spawn-worker
 * (slice 9d) to pre-clone the repo as a bare and add a per-job
 * worktree before the devcontainer boots.
 *
 * Shape mirrors `SpawnRepoSpec` from `@ecruz165/harness-server` (which
 * the spawn primitive owns) — declared here so the catalog can carry
 * the same shape without harness-core having to depend on
 * harness-server. Values cross the package boundary structurally.
 */
export interface ProductRepo {
  /** Local name — also the directory under `/workspace/<name>/` in
   *  the container's synthetic monorepo (PRD F19). */
  name: string;
  /** git clone URL — SSH (`git@github.com:org/repo.git`) or HTTPS
   *  (`https://github.com/org/repo.git`). For private repos under
   *  HTTPS, callers can inject a PAT via `cloneEnv` on the worker
   *  spawn (slice 9d-2-creds) or use the URL form
   *  `https://<token>@github.com/...`. */
  cloneUrl: string;
  /** Optional base ref to clone (default: remote's default branch). */
  baseRef?: string;
  /** Optional in-container mount path. Defaults to `/workspace/<name>/`
   *  per F19's synthetic-monorepo convention. */
  path?: string;
}

/**
 * Product = a tenant boundary with its declared content sources. Per
 * project_authority_model_jobs_pipelines, products are admin-owned shapes
 * the runtime references at job-acceptance time. They live alongside
 * pipelines in the unified Catalog.
 */
export interface ProductDef {
  id: string;
  description?: string;
  contextSources?: ContextSourceDef[];
  /**
   * Per-product git repos. When present, harness-server can resolve
   * `repos` for the container path (slice 9d-4) without the job
   * submission having to carry them — caller submits productId, the
   * server looks up the repo list. Per memory
   * `project_authority_model_jobs_pipelines`: products are admin-
   * owned, so this is the authoritative source of truth for which
   * repos belong to a product.
   *
   * When absent, callers must pass `repos` on the submission body
   * (slice 9d-4 fallback path).
   */
  repos?: ProductRepo[];
}

export interface FlowCatalog {
  flows: FlowDef[];
}

/**
 * Unified Catalog — flows + products. This is the single shape that flows
 * through `loadCatalog: () => Promise<Catalog>`. `FlowCatalog` is the
 * flows-only type; `Catalog` extends it with the additional axes.
 */
export interface Catalog extends FlowCatalog {
  /** Optional in v1 — workspaces without products skip this. */
  products?: ProductDef[];
}

export class CatalogError extends Error {}

const EMPTY: FlowCatalog = { flows: [] };

/**
 * Reads the catalog file. Missing file → empty catalog (no throw) so a fresh
 * workspace boots without a config file. Malformed JSON or wrong shape throws
 * `CatalogError` with a path-prefixed message — fail loud on bad config.
 *
 * Catalog `accepts` Record-form (named sets) is preserved through loading.
 * Set selection happens per-job at submission time via `resolveAccepts`.
 */
export async function loadCatalog(workspaceRoot: string): Promise<FlowCatalog> {
  const path = join(workspaceRoot, '.harness', 'config', 'flows.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw new CatalogError(`failed to read ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CatalogError(`${path}: invalid JSON — ${(err as Error).message}`);
  }

  validateFlowCatalog(parsed, path);
  return parsed as FlowCatalog;
}

/**
 * Project an agent's `accepts` field to a flat list for a given set name.
 *
 *   - undefined accepts → returns undefined (legacy / no-binding agent)
 *   - flat string[] accepts → returned as-is, set name ignored
 *   - Record<set, string[]> accepts → returns accepts[setName] OR
 *     accepts.default OR throws CatalogError
 *
 * Per memory `project_set_scoped_accepts`: this is called per-job at
 * submission time using the `set` field of the job submission. A single
 * running harness can serve different sets concurrently — natural for
 * benchmarking and per-customer policy.
 */
export function resolveAccepts(agent: AgentDef, setName: string): readonly string[] | undefined {
  const a = agent.accepts;
  if (a === undefined) return undefined;
  if (Array.isArray(a)) return a;
  const sets = a as Record<string, readonly string[]>;
  const picked = sets[setName] ?? sets.default;
  if (!picked) {
    throw new CatalogError(
      `agent "${agent.id}" has no "${setName}" set and no "default" set ` +
        `(declared sets: ${Object.keys(sets).join(', ')})`,
    );
  }
  return picked;
}

function validateFlowCatalog(value: unknown, path: string): asserts value is FlowCatalog {
  if (!value || typeof value !== 'object') {
    throw new CatalogError(`${path}: top-level must be an object`);
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.flows)) {
    throw new CatalogError(`${path}: missing "flows" array`);
  }
  const ids = new Set<string>();
  for (const [i, f] of obj.flows.entries()) {
    validateFlow(f, `${path}: flows[${i}]`);
    const flow = f as unknown as Record<string, unknown>;
    if (ids.has(flow.id as string)) {
      throw new CatalogError(`${path}: duplicate flow id "${flow.id}"`);
    }
    ids.add(flow.id as string);
  }
}

/**
 * Validate a single FlowDef: kind discriminator + output contract +
 * nodes (each TaskStep) + edges (referential integrity + cardinality
 * rules + acyclicity except along reject edges) + exactly-one-trigger.
 */
function validateFlow(value: unknown, where: string): asserts value is FlowDef {
  if (!value || typeof value !== 'object') {
    throw new CatalogError(`${where} must be an object`);
  }
  const flow = value as Record<string, unknown>;
  if (typeof flow.id !== 'string' || !flow.id) {
    throw new CatalogError(`${where}.id must be a non-empty string`);
  }

  // kind discriminator (optional, default 'work')
  if (flow.kind !== undefined) {
    const validKinds = new Set(['work', 'job-definition', 'post-job']);
    if (typeof flow.kind !== 'string' || !validKinds.has(flow.kind)) {
      throw new CatalogError(
        `${where}.kind must be one of: ${[...validKinds].join(', ')} (got ${JSON.stringify(flow.kind)})`,
      );
    }
  }
  const kind = (flow.kind as string | undefined) ?? 'work';

  if (flow.output !== undefined) {
    validateFlowOutputContract(flow.output, `${where}.output`);
  }
  if (kind === 'job-definition') {
    const out = flow.output as { kind?: string } | undefined;
    if (!out || out.kind !== 'job-intent') {
      throw new CatalogError(`${where}: kind 'job-definition' requires output.kind 'job-intent'`);
    }
  }

  if (!Array.isArray(flow.nodes) || flow.nodes.length === 0) {
    throw new CatalogError(`${where}.nodes must be a non-empty array`);
  }
  if (!Array.isArray(flow.edges)) {
    throw new CatalogError(`${where}.edges must be an array (may be empty)`);
  }

  // Validate each node + collect ids
  const nodeIds = new Set<string>();
  const nodeKinds = new Map<string, string>();
  const nodeTags = new Map<string, Record<string, unknown> | undefined>();
  let triggerCount = 0;
  for (const [j, n] of (flow.nodes as unknown[]).entries()) {
    const nodeWhere = `${where}.nodes[${j}]`;
    validateNode(n, nodeWhere);
    const node = n as Record<string, unknown>;
    if (nodeIds.has(node.id as string)) {
      throw new CatalogError(`${where} has duplicate node id "${node.id}"`);
    }
    nodeIds.add(node.id as string);
    nodeKinds.set(node.id as string, node.kind as string);
    nodeTags.set(node.id as string, node.tags as Record<string, unknown> | undefined);
    if (node.kind === 'trigger') triggerCount++;
  }

  if (triggerCount === 0) {
    throw new CatalogError(`${where}: exactly one node must have kind 'trigger' (got 0)`);
  }
  if (triggerCount > 1) {
    throw new CatalogError(
      `${where}: exactly one node must have kind 'trigger' (got ${triggerCount})`,
    );
  }

  // Validate each edge + cardinality rules + referential integrity
  const outgoingByType = new Map<string, Map<string, number>>(); // from → (type → count)
  const incomingCount = new Map<string, number>();
  for (const [j, e] of (flow.edges as unknown[]).entries()) {
    const edgeWhere = `${where}.edges[${j}]`;
    validateEdge(e, edgeWhere);
    const edge = e as Record<string, unknown>;
    if (!nodeIds.has(edge.from as string)) {
      throw new CatalogError(`${edgeWhere}.from references unknown node "${edge.from}"`);
    }
    if (!nodeIds.has(edge.to as string)) {
      throw new CatalogError(`${edgeWhere}.to references unknown node "${edge.to}"`);
    }
    const fromMap = outgoingByType.get(edge.from as string) ?? new Map<string, number>();
    fromMap.set(edge.type as string, (fromMap.get(edge.type as string) ?? 0) + 1);
    outgoingByType.set(edge.from as string, fromMap);
    incomingCount.set(edge.to as string, (incomingCount.get(edge.to as string) ?? 0) + 1);

    // Edge-cardinality rules
    if (edge.type === 'error' && (fromMap.get('error') ?? 0) > 1) {
      throw new CatalogError(`${edgeWhere}: at most one 'error' edge allowed per source node`);
    }
    if (edge.type === 'fallback' && (fromMap.get('fallback') ?? 0) > 1) {
      throw new CatalogError(`${edgeWhere}: at most one 'fallback' edge allowed per source node`);
    }
    if (edge.type === 'reject' && (fromMap.get('reject') ?? 0) > 1) {
      throw new CatalogError(`${edgeWhere}: at most one 'reject' edge allowed per source node`);
    }

    // Reject edges may only originate from gate or approval-tagged nodes
    if (edge.type === 'reject') {
      const fromKind = nodeKinds.get(edge.from as string);
      const fromTags = nodeTags.get(edge.from as string);
      const isGate = fromKind === 'gate';
      const hasApproval = !!(fromTags && (fromTags as Record<string, unknown>).approval);
      if (!isGate && !hasApproval) {
        throw new CatalogError(
          `${edgeWhere}: reject edges may only originate from kind:'gate' nodes or Approval-tagged nodes (source "${edge.from}" is kind:'${fromKind}' without approval tag)`,
        );
      }

      // onMaxAttempts.escalate target must be a known node
      if (edge.onMaxAttempts !== undefined) {
        const oma = edge.onMaxAttempts as Record<string, unknown>;
        if (oma.kind === 'escalate' && typeof oma.to === 'string' && !nodeIds.has(oma.to)) {
          throw new CatalogError(
            `${edgeWhere}.onMaxAttempts.to references unknown node "${oma.to}"`,
          );
        }
      }
    }
  }

  // Trigger constraints: no incoming edges, ≥1 outgoing
  for (const node of flow.nodes as Array<Record<string, unknown>>) {
    if (node.kind !== 'trigger') continue;
    if ((incomingCount.get(node.id as string) ?? 0) > 0) {
      throw new CatalogError(`${where}: trigger node "${node.id}" must have no incoming edges`);
    }
    const out = outgoingByType.get(node.id as string);
    const totalOut = out ? [...out.values()].reduce((a, b) => a + b, 0) : 0;
    if (totalOut === 0) {
      throw new CatalogError(
        `${where}: trigger node "${node.id}" must have at least one outgoing edge`,
      );
    }
  }

  // DAG check: only reject edges may form cycles. Run cycle detection
  // on the (sequence | conditional | fallback | error) sub-graph.
  const dagAdjacency = new Map<string, string[]>();
  for (const e of flow.edges as Array<Record<string, unknown>>) {
    if (e.type === 'reject') continue; // reject edges are cycle-allowed
    const from = e.from as string;
    const to = e.to as string;
    const list = dagAdjacency.get(from) ?? [];
    list.push(to);
    dagAdjacency.set(from, list);
  }
  if (hasCycle(dagAdjacency)) {
    throw new CatalogError(
      `${where}: cycle detected on non-reject edges (only reject edges may form cycles for retry-with-context loops)`,
    );
  }
}

/**
 * DFS cycle detection. Returns true if any cycle exists in the directed
 * adjacency. Used to enforce "non-reject edges form a DAG" constraint.
 */
function hasCycle(adjacency: Map<string, string[]>): boolean {
  const WHITE = 0;
  const _GRAY = 1;
  const _BLACK = 2;
  const color = new Map<string, number>();
  for (const node of adjacency.keys()) color.set(node, WHITE);
  for (const node of adjacency.keys()) {
    if (color.get(node) === WHITE) {
      if (dfsCycle(node, adjacency, color)) return true;
    }
  }
  return false;
}

function dfsCycle(
  node: string,
  adjacency: Map<string, string[]>,
  color: Map<string, number>,
): boolean {
  color.set(node, 1); // gray
  for (const next of adjacency.get(node) ?? []) {
    const c = color.get(next) ?? 0;
    if (c === 1) return true; // back edge — cycle
    if (c === 0 && dfsCycle(next, adjacency, color)) return true;
  }
  color.set(node, 2); // black
  return false;
}

/**
 * Validate a single AgentDef. Centralized so legacy `agents[]` and new
 * `AgentStep` validation share the same rules. `agentIds` is a per-pipeline
 * set tracking already-seen agent ids for duplicate detection.
 */
function validateAgentDef(value: unknown, where: string, agentIds: Set<string>): void {
  if (!value || typeof value !== 'object') {
    throw new CatalogError(`${where} must be an object`);
  }
  const agent = value as Record<string, unknown>;
  if (typeof agent.id !== 'string' || !agent.id) {
    throw new CatalogError(`${where}.id must be a non-empty string`);
  }
  if (agentIds.has(agent.id)) {
    throw new CatalogError(`${where} has duplicate agent id "${agent.id}"`);
  }
  agentIds.add(agent.id);
  if (typeof agent.role !== 'string' || !agent.role) {
    throw new CatalogError(`${where}.role must be a non-empty string`);
  }
  if (agent.adapter !== 'claude-sdk' && agent.adapter !== 'opencode-cli') {
    throw new CatalogError(`${where}.adapter must be "claude-sdk" or "opencode-cli"`);
  }
  if (agent.systemPrompt !== undefined && typeof agent.systemPrompt !== 'string') {
    throw new CatalogError(`${where}.systemPrompt must be a string`);
  }
  if (agent.accepts !== undefined) {
    validateAcceptsField(agent.accepts, `${where}.accepts`);
  }
  if (agent.fallbackOn !== undefined) {
    validateFallbackOnField(agent.fallbackOn, `${where}.fallbackOn`);
  }
  if (agent.skillz !== undefined) {
    validateSkillzField(agent.skillz, `${where}.skillz`);
  }
}

/**
 * Validate a single TaskStep (node). Checks `kind` discriminator, per-kind
 * config shape, optional tags (approval/suspend/loop), optional policy,
 * optional joinStrategy, optional terminal field.
 */
const VALID_NODE_KINDS = new Set([
  'agent',
  'tool',
  'script',
  'transform',
  'gate',
  'subflow',
  'trigger',
]);

function validateNode(value: unknown, where: string): void {
  if (!value || typeof value !== 'object') {
    throw new CatalogError(`${where} must be an object`);
  }
  const node = value as Record<string, unknown>;
  if (typeof node.id !== 'string' || !node.id) {
    throw new CatalogError(`${where}.id must be a non-empty string`);
  }
  if (typeof node.kind !== 'string' || !VALID_NODE_KINDS.has(node.kind)) {
    throw new CatalogError(
      `${where}.kind must be one of: ${[...VALID_NODE_KINDS].join(', ')} (got ${JSON.stringify(node.kind)})`,
    );
  }
  if (!node.config || typeof node.config !== 'object') {
    throw new CatalogError(`${where}.config must be an object`);
  }
  validateNodeConfig(node.kind, node.config, `${where}.config`);

  if (node.tags !== undefined) {
    validateTaskStepTags(node.tags, `${where}.tags`);
  }
  if (node.policy !== undefined) {
    validateTaskStepPolicy(node.policy, `${where}.policy`);
  }
  if (node.joinStrategy !== undefined) {
    validateJoinStrategy(node.joinStrategy, `${where}.joinStrategy`);
  }
  if (node.terminal !== undefined && node.terminal !== 'success' && node.terminal !== 'fail') {
    throw new CatalogError(`${where}.terminal must be 'success' or 'fail' when present`);
  }
}

function validateNodeConfig(kind: string, config: object, where: string): void {
  const c = config as Record<string, unknown>;
  switch (kind) {
    case 'agent': {
      const agentIds = new Set<string>();
      validateAgentDef(c.agent, `${where}.agent`, agentIds);
      break;
    }
    case 'tool':
      if (typeof c.toolId !== 'string' || !c.toolId) {
        throw new CatalogError(`${where}.toolId must be a non-empty string`);
      }
      break;
    case 'script':
      if (c.language !== 'bash' && c.language !== 'node' && c.language !== 'python') {
        throw new CatalogError(
          `${where}.language must be one of: bash, node, python (got ${JSON.stringify(c.language)})`,
        );
      }
      if (typeof c.source !== 'string') {
        throw new CatalogError(`${where}.source must be a string`);
      }
      break;
    case 'transform':
      validateExpression(c.expression, `${where}.expression`);
      break;
    case 'gate':
      if (!Array.isArray(c.assertions) || c.assertions.length === 0) {
        throw new CatalogError(`${where}.assertions must be a non-empty array`);
      }
      for (const [k, a] of (c.assertions as unknown[]).entries()) {
        if (!a || typeof a !== 'object') {
          throw new CatalogError(`${where}.assertions[${k}] must be an object`);
        }
        const assertion = a as Record<string, unknown>;
        validateExpression(assertion.expression, `${where}.assertions[${k}].expression`);
        if (typeof assertion.message !== 'string' || !assertion.message) {
          throw new CatalogError(`${where}.assertions[${k}].message must be a non-empty string`);
        }
      }
      break;
    case 'subflow':
      if (typeof c.flowId !== 'string' || !c.flowId) {
        throw new CatalogError(`${where}.flowId must be a non-empty string`);
      }
      break;
    case 'trigger':
      validateTriggerConfig(c, where);
      break;
  }
}

function validateTriggerConfig(c: Record<string, unknown>, where: string): void {
  switch (c.kind) {
    case 'webhook':
      if (typeof c.path !== 'string' || !c.path) {
        throw new CatalogError(`${where}.path must be a non-empty string`);
      }
      if (c.method !== undefined && c.method !== 'GET' && c.method !== 'POST') {
        throw new CatalogError(`${where}.method must be 'GET' or 'POST' when present`);
      }
      break;
    case 'schedule':
      if (typeof c.cron !== 'string' || !c.cron) {
        throw new CatalogError(`${where}.cron must be a non-empty string`);
      }
      break;
    case 'manual':
      // No additional fields.
      break;
    case 'event':
      if (typeof c.eventType !== 'string' || !c.eventType) {
        throw new CatalogError(`${where}.eventType must be a non-empty string`);
      }
      if (c.matcher !== undefined) {
        validateExpression(c.matcher, `${where}.matcher`);
      }
      break;
    case 'message':
      if (typeof c.channel !== 'string' || !c.channel) {
        throw new CatalogError(`${where}.channel must be a non-empty string`);
      }
      break;
    default:
      throw new CatalogError(
        `${where}.kind must be one of: webhook, schedule, manual, event, message (got ${JSON.stringify(c.kind)})`,
      );
  }
}

function validateTaskStepTags(value: unknown, where: string): void {
  if (!value || typeof value !== 'object') {
    throw new CatalogError(`${where} must be an object`);
  }
  const tags = value as Record<string, unknown>;
  if (tags.approval !== undefined && tags.suspend !== undefined) {
    throw new CatalogError(
      `${where}: approval and suspend tags are mutually exclusive on the same node`,
    );
  }
  if (tags.approval !== undefined) {
    validateApprovalTag(tags.approval, `${where}.approval`);
  }
  if (tags.suspend !== undefined) {
    validateSuspendTag(tags.suspend, `${where}.suspend`);
  }
  if (tags.loop !== undefined) {
    validateLoopTag(tags.loop, `${where}.loop`);
  }
}

function validateApprovalTag(value: unknown, where: string): void {
  if (!value || typeof value !== 'object') {
    throw new CatalogError(`${where} must be an object`);
  }
  const t = value as Record<string, unknown>;
  if (typeof t.assigneeRole !== 'string' || !t.assigneeRole) {
    throw new CatalogError(`${where}.assigneeRole must be a non-empty string`);
  }
  if (typeof t.slaMs !== 'number' || t.slaMs <= 0) {
    throw new CatalogError(`${where}.slaMs must be a positive number`);
  }
  if (t.concurrency !== 'pessimistic') {
    throw new CatalogError(
      `${where}.concurrency must be 'pessimistic' (only mode supported in v1)`,
    );
  }
}

function validateSuspendTag(value: unknown, where: string): void {
  if (!value || typeof value !== 'object') {
    throw new CatalogError(`${where} must be an object`);
  }
  const t = value as Record<string, unknown>;
  if (!t.trigger || typeof t.trigger !== 'object') {
    throw new CatalogError(`${where}.trigger must be an object`);
  }
  const trig = t.trigger as Record<string, unknown>;
  if (trig.kind === 'timer') {
    if (typeof trig.durationMs !== 'number' || trig.durationMs <= 0) {
      throw new CatalogError(`${where}.trigger.durationMs must be a positive number`);
    }
  } else if (trig.kind === 'event') {
    if (typeof trig.eventType !== 'string' || !trig.eventType) {
      throw new CatalogError(`${where}.trigger.eventType must be a non-empty string`);
    }
    if (trig.matcher !== undefined) {
      validateExpression(trig.matcher, `${where}.trigger.matcher`);
    }
  } else {
    throw new CatalogError(
      `${where}.trigger.kind must be 'timer' or 'event' (got ${JSON.stringify(trig.kind)})`,
    );
  }
}

function validateLoopTag(value: unknown, where: string): void {
  if (!value || typeof value !== 'object') {
    throw new CatalogError(`${where} must be an object`);
  }
  const t = value as Record<string, unknown>;
  if (t.source !== 'collection' && t.source !== 'directory') {
    throw new CatalogError(
      `${where}.source must be 'collection' or 'directory' (got ${JSON.stringify(t.source)})`,
    );
  }
  validateExpression(t.path, `${where}.path`);
  if (t.mode !== 'sequential' && t.mode !== 'parallel') {
    throw new CatalogError(
      `${where}.mode must be 'sequential' or 'parallel' (got ${JSON.stringify(t.mode)})`,
    );
  }
  if (t.concurrency !== undefined && (typeof t.concurrency !== 'number' || t.concurrency <= 0)) {
    throw new CatalogError(`${where}.concurrency must be a positive number when present`);
  }
}

function validateTaskStepPolicy(value: unknown, where: string): void {
  if (!value || typeof value !== 'object') {
    throw new CatalogError(`${where} must be an object`);
  }
  const p = value as Record<string, unknown>;
  if (p.retry !== undefined) {
    if (!p.retry || typeof p.retry !== 'object') {
      throw new CatalogError(`${where}.retry must be an object`);
    }
    const r = p.retry as Record<string, unknown>;
    if (typeof r.maxAttempts !== 'number' || r.maxAttempts <= 0) {
      throw new CatalogError(`${where}.retry.maxAttempts must be a positive number`);
    }
  }
  if (p.timeout !== undefined && (typeof p.timeout !== 'number' || p.timeout < 0)) {
    throw new CatalogError(`${where}.timeout must be a non-negative number when present`);
  }
  if (p.onError !== undefined) {
    const validOnError = new Set(['propagate', 'continue', 'fallback']);
    if (typeof p.onError !== 'string' || !validOnError.has(p.onError)) {
      throw new CatalogError(
        `${where}.onError must be one of: ${[...validOnError].join(', ')} (got ${JSON.stringify(p.onError)})`,
      );
    }
  }
}

function validateJoinStrategy(value: unknown, where: string): void {
  if (value === 'all' || value === 'any') return;
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.nOfM === 'number' && v.nOfM > 0) return;
  }
  throw new CatalogError(
    `${where} must be 'all', 'any', or { nOfM: <positive number> } (got ${JSON.stringify(value)})`,
  );
}

function validateExpression(value: unknown, where: string): void {
  if (!value || typeof value !== 'object') {
    throw new CatalogError(`${where} must be an Expression object`);
  }
  const e = value as Record<string, unknown>;
  switch (e.kind) {
    case 'jsonpath':
      if (typeof e.path !== 'string' || !e.path) {
        throw new CatalogError(`${where}.path must be a non-empty string`);
      }
      break;
    case 'js':
      if (typeof e.expression !== 'string' || !e.expression) {
        throw new CatalogError(`${where}.expression must be a non-empty string`);
      }
      break;
    case 'literal':
      if (!('value' in e)) throw new CatalogError(`${where}.value is required`);
      break;
    default:
      throw new CatalogError(
        `${where}.kind must be one of: jsonpath, js, literal (got ${JSON.stringify(e.kind)})`,
      );
  }
}

function validateEdge(value: unknown, where: string): void {
  if (!value || typeof value !== 'object') {
    throw new CatalogError(`${where} must be an object`);
  }
  const edge = value as Record<string, unknown>;
  if (typeof edge.from !== 'string' || !edge.from) {
    throw new CatalogError(`${where}.from must be a non-empty string`);
  }
  if (typeof edge.to !== 'string' || !edge.to) {
    throw new CatalogError(`${where}.to must be a non-empty string`);
  }
  const validTypes = new Set(['sequence', 'conditional', 'fallback', 'error', 'reject']);
  if (typeof edge.type !== 'string' || !validTypes.has(edge.type)) {
    throw new CatalogError(
      `${where}.type must be one of: ${[...validTypes].join(', ')} (got ${JSON.stringify(edge.type)})`,
    );
  }
  if (edge.type === 'conditional') {
    validateExpression(edge.condition, `${where}.condition`);
  }
  if (edge.type === 'reject') {
    if (
      edge.maxAttempts !== undefined &&
      (typeof edge.maxAttempts !== 'number' || edge.maxAttempts <= 0)
    ) {
      throw new CatalogError(`${where}.maxAttempts must be a positive number when present`);
    }
    if (edge.onMaxAttempts !== undefined) {
      if (!edge.onMaxAttempts || typeof edge.onMaxAttempts !== 'object') {
        throw new CatalogError(`${where}.onMaxAttempts must be an object when present`);
      }
      const oma = edge.onMaxAttempts as Record<string, unknown>;
      if (oma.kind === 'fail') {
        // OK
      } else if (oma.kind === 'escalate') {
        if (typeof oma.to !== 'string' || !oma.to) {
          throw new CatalogError(`${where}.onMaxAttempts.to must be a non-empty string`);
        }
      } else {
        throw new CatalogError(
          `${where}.onMaxAttempts.kind must be 'fail' or 'escalate' (got ${JSON.stringify(oma.kind)})`,
        );
      }
    }
  }
}

function validateFlowOutputContract(value: unknown, where: string): void {
  if (!value || typeof value !== 'object') {
    throw new CatalogError(`${where} must be an object`);
  }
  const o = value as Record<string, unknown>;
  const validKinds = new Set([
    'agent-text',
    'job-intent',
    'job-intents',
    'flow-spec',
    'structured',
  ]);
  if (typeof o.kind !== 'string' || !validKinds.has(o.kind)) {
    throw new CatalogError(
      `${where}.kind must be one of: ${[...validKinds].join(', ')} (got ${JSON.stringify(o.kind)})`,
    );
  }
  if (o.kind === 'job-intents') {
    if (o.min !== undefined && (typeof o.min !== 'number' || o.min < 0))
      throw new CatalogError(`${where}.min must be a non-negative number`);
    if (o.max !== undefined && (typeof o.max !== 'number' || o.max < 0))
      throw new CatalogError(`${where}.max must be a non-negative number`);
  }
  if (o.kind === 'structured' && o.schema === undefined) {
    throw new CatalogError(`${where}.schema is required`);
  }
}

/** Validate the optional `skillz` field on an AgentDef. Each category
 *  (tools, integrations, tasks, workflows) is optional; when present it
 *  must be an array of non-empty strings. Slug syntax is not validated
 *  here — that's a runtime concern of the procurement flow. */
function validateSkillzField(value: unknown, where: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CatalogError(`${where} must be an object`);
  }
  const skillz = value as Record<string, unknown>;
  const validKeys = new Set(['routers', 'tools', 'integrations', 'tasks', 'workflows']);
  for (const key of Object.keys(skillz)) {
    if (!validKeys.has(key)) {
      throw new CatalogError(
        `${where} has unknown key "${key}"; allowed: ${[...validKeys].join(', ')}`,
      );
    }
    const list = skillz[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      throw new CatalogError(`${where}.${key} must be an array of strings`);
    }
    for (const [k, slug] of list.entries()) {
      if (typeof slug !== 'string' || slug.length === 0) {
        throw new CatalogError(`${where}.${key}[${k}] must be a non-empty string`);
      }
    }
  }
}

/** Closed set of valid AdapterError names accepted in `fallbackOn`. Kept
 *  in sync with the class hierarchy in `agent-adapter/src/errors.ts`.
 *  We don't import from agent-adapter to avoid the package-graph cycle
 *  (harness-core ← agent-adapter); validation is done by string match. */
const VALID_FALLBACK_ERROR_NAMES = new Set<string>([
  'AdapterError', // wildcard — falls back on any classified error
  'AuthError',
  'BillingError',
  'RateLimitError',
  'ConfigError',
  'NetworkError',
  'ProviderError',
]);

function validateFallbackOnField(value: unknown, where: string): void {
  if (!Array.isArray(value)) {
    throw new CatalogError(
      `${where} must be an array of AdapterError subclass names ` +
        `(e.g., ["BillingError", "RateLimitError"]) — got ${typeof value}`,
    );
  }
  for (const [k, entry] of value.entries()) {
    if (typeof entry !== 'string' || !entry) {
      throw new CatalogError(`${where}[${k}] must be a non-empty string`);
    }
    if (!VALID_FALLBACK_ERROR_NAMES.has(entry)) {
      throw new CatalogError(
        `${where}[${k}] = "${entry}" is not a known AdapterError subclass. ` +
          `Valid: ${[...VALID_FALLBACK_ERROR_NAMES].sort().join(', ')}`,
      );
    }
  }
}

/**
 * Validates either form of `accepts`: flat array of `<provider>:<model>`
 * strings, OR a Record mapping set name → array of the same shape.
 *
 * Each leaf entry must be a non-empty string with exactly one separating
 * colon and non-empty halves. Set names must be non-empty strings; the
 * Record must declare at least one set.
 */
function validateAcceptsField(value: unknown, where: string): void {
  if (Array.isArray(value)) {
    validateAcceptsList(value, where);
    return;
  }
  if (value && typeof value === 'object') {
    const sets = value as Record<string, unknown>;
    const setNames = Object.keys(sets);
    if (setNames.length === 0) {
      throw new CatalogError(`${where} must declare at least one set (got an empty object)`);
    }
    for (const setName of setNames) {
      if (!setName) {
        throw new CatalogError(`${where} has an empty set name`);
      }
      const list = sets[setName];
      if (!Array.isArray(list)) {
        throw new CatalogError(
          `${where}["${setName}"] must be an array of "<provider>:<model>" strings`,
        );
      }
      validateAcceptsList(list, `${where}["${setName}"]`);
    }
    return;
  }
  throw new CatalogError(
    `${where} must be an array of "<provider>:<model>" strings ` +
      `OR an object mapping set name → array of those strings`,
  );
}

function validateAcceptsList(list: unknown[], where: string): void {
  for (const [k, entry] of list.entries()) {
    if (typeof entry !== 'string' || !entry) {
      throw new CatalogError(`${where}[${k}] must be a non-empty string`);
    }
    const colon = entry.indexOf(':');
    if (colon <= 0 || colon === entry.length - 1) {
      throw new CatalogError(
        `${where}[${k}] must be of the form "<provider>:<model>" or ` +
          `"<tool>:<provider>:<model>" (got "${entry}")`,
      );
    }
  }
}

export function findFlow(catalog: FlowCatalog, id: string): FlowDef | undefined {
  return catalog.flows.find((f) => f.id === id);
}

export function findProduct(catalog: Catalog, id: string): ProductDef | undefined {
  return catalog.products?.find((p) => p.id === id);
}

/**
 * Validates the unified Catalog shape. Reuses flow validation
 * (which is already comprehensive) and adds product-shape checks.
 * Caller-supplied path is included in error messages so YAML/JSON
 * sources surface bad-config locations without the validator needing
 * to know what kind of file it came from.
 */
export function validateUnifiedCatalog(value: unknown, path: string): asserts value is Catalog {
  if (!value || typeof value !== 'object') {
    throw new CatalogError(`${path}: top-level must be an object`);
  }
  const obj = value as Record<string, unknown>;
  // Flows is required (even if empty array — distinguishes "I have
  // no flows" from "I forgot the field").
  if (!Array.isArray(obj.flows)) {
    throw new CatalogError(`${path}: missing "flows" array (use [] for none)`);
  }
  // Re-use the flows-only validator.
  validateFlowCatalog({ flows: obj.flows }, path);

  if (obj.products !== undefined) {
    if (!Array.isArray(obj.products)) {
      throw new CatalogError(`${path}: "products" must be an array if present`);
    }
    const ids = new Set<string>();
    for (const [i, p] of obj.products.entries()) {
      if (!p || typeof p !== 'object') {
        throw new CatalogError(`${path}: products[${i}] must be an object`);
      }
      const product = p as Record<string, unknown>;
      if (typeof product.id !== 'string' || !product.id) {
        throw new CatalogError(`${path}: products[${i}].id must be a non-empty string`);
      }
      if (ids.has(product.id)) {
        throw new CatalogError(`${path}: duplicate product id "${product.id}"`);
      }
      ids.add(product.id);
      if (product.contextSources !== undefined) {
        if (!Array.isArray(product.contextSources)) {
          throw new CatalogError(
            `${path}: products[${i}].contextSources must be an array if present`,
          );
        }
        for (const [j, s] of product.contextSources.entries()) {
          if (!s || typeof s !== 'object') {
            throw new CatalogError(
              `${path}: products[${i}].contextSources[${j}] must be an object`,
            );
          }
          const src = s as Record<string, unknown>;
          if (typeof src.type !== 'string' || !src.type) {
            throw new CatalogError(
              `${path}: products[${i}].contextSources[${j}].type must be a non-empty string`,
            );
          }
          if (typeof src.target !== 'string' || !src.target) {
            throw new CatalogError(
              `${path}: products[${i}].contextSources[${j}].target must be a non-empty string`,
            );
          }
        }
      }
      if (product.repos !== undefined) {
        if (!Array.isArray(product.repos)) {
          throw new CatalogError(`${path}: products[${i}].repos must be an array if present`);
        }
        const repoNames = new Set<string>();
        for (const [j, r] of product.repos.entries()) {
          if (!r || typeof r !== 'object') {
            throw new CatalogError(`${path}: products[${i}].repos[${j}] must be an object`);
          }
          const repo = r as Record<string, unknown>;
          if (typeof repo.name !== 'string' || !repo.name) {
            throw new CatalogError(
              `${path}: products[${i}].repos[${j}].name must be a non-empty string`,
            );
          }
          if (repoNames.has(repo.name)) {
            throw new CatalogError(
              `${path}: products[${i}].repos has duplicate name "${repo.name}"`,
            );
          }
          repoNames.add(repo.name);
          if (typeof repo.cloneUrl !== 'string' || !repo.cloneUrl) {
            throw new CatalogError(
              `${path}: products[${i}].repos[${j}].cloneUrl must be a non-empty string`,
            );
          }
          if (repo.baseRef !== undefined && (typeof repo.baseRef !== 'string' || !repo.baseRef)) {
            throw new CatalogError(
              `${path}: products[${i}].repos[${j}].baseRef must be a non-empty string when present`,
            );
          }
          if (repo.path !== undefined && (typeof repo.path !== 'string' || !repo.path)) {
            throw new CatalogError(
              `${path}: products[${i}].repos[${j}].path must be a non-empty string when present`,
            );
          }
        }
      }
    }
  }
}

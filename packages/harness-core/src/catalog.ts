import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The pipeline catalog declares which pipelines the harness knows about and,
 * for each, the agents that compose it. Per the authority memory, the catalog
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
}

export interface PipelineDef {
  id: string;
  description?: string;
  agents: AgentDef[];
}

/**
 * One context-source declaration on a product. Mirrors the shape used in
 * `<workspace>/.harness/config/context-sources.yml` and in
 * harness-workspace.yml's per-product `contextSources` block. The loader
 * consumes these one-per-spawned-worker when `harness context load
 * --product X` lands.
 */
export interface ContextSourceDef {
  /** Source-type id from @agentx/context-loader-core's catalog
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
 * Shape mirrors `SpawnRepoSpec` from `@agentx/harness-server` (which
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

export interface PipelineCatalog {
  pipelines: PipelineDef[];
}

/**
 * Unified Catalog — pipelines + products + (future) agents. This is the
 * single shape that flows through `loadCatalog: () => Promise<Catalog>`.
 * `PipelineCatalog` is the original pipelines-only type; `Catalog` extends
 * it with the additional axes. Existing consumers that only need pipelines
 * can keep typing against `PipelineCatalog`; new consumers reach for
 * `Catalog`.
 */
export interface Catalog extends PipelineCatalog {
  /** Optional in v1 — workspaces without products skip this. */
  products?: ProductDef[];
}

export class CatalogError extends Error {}

const EMPTY: PipelineCatalog = { pipelines: [] };

/**
 * Reads the catalog file. Missing file → empty catalog (no throw) so a fresh
 * workspace boots without a config file. Malformed JSON or wrong shape throws
 * `CatalogError` with a path-prefixed message — fail loud on bad config.
 *
 * Catalog `accepts` Record-form (named sets) is preserved through loading.
 * Set selection happens per-job at submission time via `resolveAccepts`.
 */
export async function loadCatalog(workspaceRoot: string): Promise<PipelineCatalog> {
  const path = join(workspaceRoot, '.harness', 'config', 'pipelines.json');
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

  validateCatalog(parsed, path);
  return parsed as PipelineCatalog;
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
export function resolveAccepts(
  agent: AgentDef,
  setName: string
): readonly string[] | undefined {
  const a = agent.accepts;
  if (a === undefined) return undefined;
  if (Array.isArray(a)) return a;
  const sets = a as Record<string, readonly string[]>;
  const picked = sets[setName] ?? sets.default;
  if (!picked) {
    throw new CatalogError(
      `agent "${agent.id}" has no "${setName}" set and no "default" set ` +
        `(declared sets: ${Object.keys(sets).join(', ')})`
    );
  }
  return picked;
}

function validateCatalog(value: unknown, path: string): asserts value is PipelineCatalog {
  if (!value || typeof value !== 'object') {
    throw new CatalogError(`${path}: top-level must be an object`);
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.pipelines)) {
    throw new CatalogError(`${path}: missing "pipelines" array`);
  }
  const ids = new Set<string>();
  for (const [i, p] of obj.pipelines.entries()) {
    if (!p || typeof p !== 'object') {
      throw new CatalogError(`${path}: pipelines[${i}] must be an object`);
    }
    const pipeline = p as Record<string, unknown>;
    if (typeof pipeline.id !== 'string' || !pipeline.id) {
      throw new CatalogError(`${path}: pipelines[${i}].id must be a non-empty string`);
    }
    if (ids.has(pipeline.id)) {
      throw new CatalogError(`${path}: duplicate pipeline id "${pipeline.id}"`);
    }
    ids.add(pipeline.id);
    if (!Array.isArray(pipeline.agents) || pipeline.agents.length === 0) {
      throw new CatalogError(`${path}: pipelines[${i}].agents must be a non-empty array`);
    }
    const agentIds = new Set<string>();
    for (const [j, a] of pipeline.agents.entries()) {
      if (!a || typeof a !== 'object') {
        throw new CatalogError(`${path}: pipelines[${i}].agents[${j}] must be an object`);
      }
      const agent = a as Record<string, unknown>;
      if (typeof agent.id !== 'string' || !agent.id) {
        throw new CatalogError(`${path}: pipelines[${i}].agents[${j}].id must be a non-empty string`);
      }
      if (agentIds.has(agent.id)) {
        throw new CatalogError(`${path}: pipelines[${i}] has duplicate agent id "${agent.id}"`);
      }
      agentIds.add(agent.id);
      if (typeof agent.role !== 'string' || !agent.role) {
        throw new CatalogError(`${path}: pipelines[${i}].agents[${j}].role must be a non-empty string`);
      }
      if (agent.adapter !== 'claude-sdk' && agent.adapter !== 'opencode-cli') {
        throw new CatalogError(
          `${path}: pipelines[${i}].agents[${j}].adapter must be "claude-sdk" or "opencode-cli"`
        );
      }
      if (agent.systemPrompt !== undefined && typeof agent.systemPrompt !== 'string') {
        throw new CatalogError(`${path}: pipelines[${i}].agents[${j}].systemPrompt must be a string`);
      }
      if (agent.accepts !== undefined) {
        validateAcceptsField(agent.accepts, `${path}: pipelines[${i}].agents[${j}].accepts`);
      }
      if (agent.fallbackOn !== undefined) {
        validateFallbackOnField(
          agent.fallbackOn,
          `${path}: pipelines[${i}].agents[${j}].fallbackOn`
        );
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
        `(e.g., ["BillingError", "RateLimitError"]) — got ${typeof value}`
    );
  }
  for (const [k, entry] of value.entries()) {
    if (typeof entry !== 'string' || !entry) {
      throw new CatalogError(`${where}[${k}] must be a non-empty string`);
    }
    if (!VALID_FALLBACK_ERROR_NAMES.has(entry)) {
      throw new CatalogError(
        `${where}[${k}] = "${entry}" is not a known AdapterError subclass. ` +
          `Valid: ${[...VALID_FALLBACK_ERROR_NAMES].sort().join(', ')}`
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
      throw new CatalogError(
        `${where} must declare at least one set (got an empty object)`
      );
    }
    for (const setName of setNames) {
      if (!setName) {
        throw new CatalogError(`${where} has an empty set name`);
      }
      const list = sets[setName];
      if (!Array.isArray(list)) {
        throw new CatalogError(
          `${where}["${setName}"] must be an array of "<provider>:<model>" strings`
        );
      }
      validateAcceptsList(list, `${where}["${setName}"]`);
    }
    return;
  }
  throw new CatalogError(
    `${where} must be an array of "<provider>:<model>" strings ` +
      `OR an object mapping set name → array of those strings`
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
          `"<tool>:<provider>:<model>" (got "${entry}")`
      );
    }
  }
}

export function findPipeline(catalog: PipelineCatalog, id: string): PipelineDef | undefined {
  return catalog.pipelines.find((p) => p.id === id);
}

export function findProduct(catalog: Catalog, id: string): ProductDef | undefined {
  return catalog.products?.find((p) => p.id === id);
}

/**
 * Validates the unified Catalog shape. Reuses pipeline validation
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
  // Pipelines is required (even if empty array — distinguishes "I have
  // no pipelines" from "I forgot the field").
  if (!Array.isArray(obj.pipelines)) {
    throw new CatalogError(`${path}: missing "pipelines" array (use [] for none)`);
  }
  // Re-use the pipeline-only validator by going through JSON to avoid
  // accidental aliasing — this is config-load time, perf is irrelevant.
  validateCatalog({ pipelines: obj.pipelines }, path);

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
            `${path}: products[${i}].contextSources must be an array if present`
          );
        }
        for (const [j, s] of product.contextSources.entries()) {
          if (!s || typeof s !== 'object') {
            throw new CatalogError(
              `${path}: products[${i}].contextSources[${j}] must be an object`
            );
          }
          const src = s as Record<string, unknown>;
          if (typeof src.type !== 'string' || !src.type) {
            throw new CatalogError(
              `${path}: products[${i}].contextSources[${j}].type must be a non-empty string`
            );
          }
          if (typeof src.target !== 'string' || !src.target) {
            throw new CatalogError(
              `${path}: products[${i}].contextSources[${j}].target must be a non-empty string`
            );
          }
        }
      }
      if (product.repos !== undefined) {
        if (!Array.isArray(product.repos)) {
          throw new CatalogError(
            `${path}: products[${i}].repos must be an array if present`
          );
        }
        const repoNames = new Set<string>();
        for (const [j, r] of product.repos.entries()) {
          if (!r || typeof r !== 'object') {
            throw new CatalogError(
              `${path}: products[${i}].repos[${j}] must be an object`
            );
          }
          const repo = r as Record<string, unknown>;
          if (typeof repo.name !== 'string' || !repo.name) {
            throw new CatalogError(
              `${path}: products[${i}].repos[${j}].name must be a non-empty string`
            );
          }
          if (repoNames.has(repo.name)) {
            throw new CatalogError(
              `${path}: products[${i}].repos has duplicate name "${repo.name}"`
            );
          }
          repoNames.add(repo.name);
          if (typeof repo.cloneUrl !== 'string' || !repo.cloneUrl) {
            throw new CatalogError(
              `${path}: products[${i}].repos[${j}].cloneUrl must be a non-empty string`
            );
          }
          if (repo.baseRef !== undefined && (typeof repo.baseRef !== 'string' || !repo.baseRef)) {
            throw new CatalogError(
              `${path}: products[${i}].repos[${j}].baseRef must be a non-empty string when present`
            );
          }
          if (repo.path !== undefined && (typeof repo.path !== 'string' || !repo.path)) {
            throw new CatalogError(
              `${path}: products[${i}].repos[${j}].path must be a non-empty string when present`
            );
          }
        }
      }
    }
  }
}

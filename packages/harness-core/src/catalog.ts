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
 * Product = a tenant boundary with its declared content sources. Per
 * project_authority_model_jobs_pipelines, products are admin-owned shapes
 * the runtime references at job-acceptance time. They live alongside
 * pipelines in the unified Catalog.
 */
export interface ProductDef {
  id: string;
  description?: string;
  contextSources?: ContextSourceDef[];
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
    }
  }
}

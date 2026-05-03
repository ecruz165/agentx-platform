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
}

export interface PipelineDef {
  id: string;
  description?: string;
  agents: AgentDef[];
}

export interface PipelineCatalog {
  pipelines: PipelineDef[];
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

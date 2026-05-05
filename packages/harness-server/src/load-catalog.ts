/**
 * Catalog loaders.
 *
 * harness-server takes `loadCatalog: () => Promise<Catalog>` at init.
 * That function is operator-supplied — local dev points it at the
 * workspace's YAML/JSON, ECS deploys point it at S3 / central Catalog.
 * The helpers here are the local-dev defaults; deploy-time loaders live
 * outside this package.
 *
 * Per the authority model: catalog is read-only at runtime. These loaders
 * fire once at server startup. To pick up a catalog edit, restart the
 * server (or v1.x: send a refresh signal that re-runs the loader).
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import {
  validateUnifiedCatalog,
  type Catalog,
  type AdapterId,
  type AgentDef,
  type PipelineDef,
  type ProductDef,
  CatalogError,
} from '@agentx/harness-core';

/**
 * Local-dev catalog loader: stitches together
 *   - <workspaceRoot>/.harness/config/pipelines.json  → catalog.pipelines
 *   - <workspaceRoot>/harness-workspace.yml          → catalog.products
 * into one unified Catalog. Either source missing is fine — empty arrays.
 *
 * Failure modes:
 *   - JSON / YAML parse errors throw `CatalogError` with the file path
 *   - Schema mismatches throw `CatalogError` from validateUnifiedCatalog
 *   - Anything thrown at startup will fail-fast harness-server before it
 *     accepts traffic (per the rule: never serve with a partial catalog)
 */
export async function loadCatalogFromWorkspaceYaml(
  workspaceRoot: string
): Promise<Catalog> {
  // Pipelines: workspace's pipelines.json uses a `phases` shape that's
  // user-friendlier than harness-core's canonical `agents` array.
  // readWorkspacePipelines accepts both shapes (phases or agents) and
  // emits canonical agents, so the catalog passes harness-core's
  // validator regardless of which form the workspace uses.
  const pipelines = await readWorkspacePipelines(workspaceRoot);

  // Products come from harness-workspace.yml's per-product `contextSources`.
  const products = await readWorkspaceYamlProducts(workspaceRoot);

  const catalog: Catalog = { pipelines, products };
  validateUnifiedCatalog(catalog, '<merged-workspace-catalog>');
  return catalog;
}

/**
 * Read `<workspaceRoot>/.harness/config/pipelines.json` and translate
 * either the `phases` shape (workspace convention) or the `agents`
 * shape (canonical) into PipelineDef[].
 *
 * Translation rules (phases → agents):
 *   phase.id              → agent.id
 *   phase.agent           → agent.adapter   ('claude-sdk' | 'opencode-cli')
 *   phase.description     → agent.role      (falls back to phase.id)
 *   phase.systemPrompt    → agent.systemPrompt
 *   phase.model           → agent.config.model
 *   phase.reasoningEffort → agent.config.reasoningEffort
 *   phase.tools           → agent.config.tools
 *
 * If a pipeline already has `agents` (canonical), use that directly.
 * If both, prefer `agents` and ignore `phases` — explicit canonical wins.
 *
 * Missing file → empty pipelines (matches harness-core's loadCatalog).
 * Malformed JSON or unknown adapter id → CatalogError with the file path.
 */
async function readWorkspacePipelines(
  workspaceRoot: string
): Promise<PipelineDef[]> {
  const path = join(workspaceRoot, '.harness', 'config', 'pipelines.json');
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new CatalogError(`failed to read ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CatalogError(`${path}: invalid JSON — ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new CatalogError(`${path}: top-level must be an object`);
  }
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.pipelines)) {
    throw new CatalogError(`${path}: missing "pipelines" array`);
  }

  return root.pipelines.map((p: unknown, i: number) => {
    if (!p || typeof p !== 'object') {
      throw new CatalogError(`${path}: pipelines[${i}] must be an object`);
    }
    const pipeline = p as Record<string, unknown>;
    if (typeof pipeline.id !== 'string' || !pipeline.id) {
      throw new CatalogError(`${path}: pipelines[${i}].id must be a non-empty string`);
    }
    const description =
      typeof pipeline.description === 'string' ? pipeline.description : undefined;

    // Prefer canonical `agents` if present; otherwise translate `phases`.
    const canonical = Array.isArray(pipeline.agents)
      ? (pipeline.agents as unknown[])
      : null;
    const phases = !canonical && Array.isArray(pipeline.phases)
      ? (pipeline.phases as unknown[])
      : null;
    if (!canonical && !phases) {
      throw new CatalogError(
        `${path}: pipelines[${i}] needs either "agents" or "phases" (got neither)`
      );
    }

    const agents: AgentDef[] = canonical
      ? canonical.map((a, j) => coerceCanonicalAgent(a, `${path}: pipelines[${i}].agents[${j}]`))
      : phases!.map((ph, j) =>
          phaseToAgent(ph, `${path}: pipelines[${i}].phases[${j}]`)
        );

    if (agents.length === 0) {
      throw new CatalogError(
        `${path}: pipelines[${i}].${canonical ? 'agents' : 'phases'} must be non-empty`
      );
    }

    const def: PipelineDef = { id: pipeline.id, agents };
    if (description !== undefined) def.description = description;
    return def;
  });
}

/** Translate one workspace `phase` into a canonical AgentDef. */
function phaseToAgent(value: unknown, path: string): AgentDef {
  if (!value || typeof value !== 'object') {
    throw new CatalogError(`${path}: must be an object`);
  }
  const phase = value as Record<string, unknown>;
  if (typeof phase.id !== 'string' || !phase.id) {
    throw new CatalogError(`${path}.id must be a non-empty string`);
  }
  const adapterRaw = phase.agent;
  if (adapterRaw !== 'claude-sdk' && adapterRaw !== 'opencode-cli') {
    throw new CatalogError(
      `${path}.agent must be "claude-sdk" or "opencode-cli" (got ${JSON.stringify(adapterRaw)})`
    );
  }
  const role =
    typeof phase.description === 'string' && phase.description ? phase.description : phase.id;
  const config: Record<string, unknown> = {};
  if (typeof phase.model === 'string') config.model = phase.model;
  if (typeof phase.reasoningEffort === 'string') {
    config.reasoningEffort = phase.reasoningEffort;
  }
  if (Array.isArray(phase.tools)) config.tools = phase.tools;
  const agent: AgentDef = {
    id: phase.id,
    role,
    adapter: adapterRaw as AdapterId,
  };
  if (typeof phase.systemPrompt === 'string') agent.systemPrompt = phase.systemPrompt;
  if (Object.keys(config).length > 0) agent.config = config;
  return agent;
}

/** Type-narrow + light validate a value that's already in canonical
 *  AgentDef shape. The unified validator runs again on the merged
 *  Catalog so this is just enough to make the construction safe. */
function coerceCanonicalAgent(value: unknown, path: string): AgentDef {
  if (!value || typeof value !== 'object') {
    throw new CatalogError(`${path}: must be an object`);
  }
  const a = value as Record<string, unknown>;
  if (typeof a.id !== 'string' || !a.id) {
    throw new CatalogError(`${path}.id must be a non-empty string`);
  }
  if (typeof a.role !== 'string' || !a.role) {
    throw new CatalogError(`${path}.role must be a non-empty string`);
  }
  if (a.adapter !== 'claude-sdk' && a.adapter !== 'opencode-cli') {
    throw new CatalogError(
      `${path}.adapter must be "claude-sdk" or "opencode-cli"`
    );
  }
  const out: AgentDef = { id: a.id, role: a.role, adapter: a.adapter as AdapterId };
  if (typeof a.systemPrompt === 'string') out.systemPrompt = a.systemPrompt;
  if (a.config && typeof a.config === 'object') {
    out.config = a.config as Record<string, unknown>;
  }
  return out;
}

/**
 * Read `harness-workspace.yml` (or .yaml) and project the per-product
 * `contextSources` arrays into the Catalog's `products` shape. Returns
 * an empty array when the file is absent or has no products.
 *
 * Schema is the same one harness-cli's workspace-config.ts validates,
 * minus the workspace-only fields (servers, worker, worktree). Those
 * stay client-side and aren't part of the runtime catalog.
 */
async function readWorkspaceYamlProducts(
  workspaceRoot: string
): Promise<ProductDef[]> {
  const candidates = [
    join(workspaceRoot, 'harness-workspace.yml'),
    join(workspaceRoot, 'harness-workspace.yaml'),
  ];
  let path: string | null = null;
  for (const c of candidates) {
    if (existsSync(c)) {
      path = c;
      break;
    }
  }
  if (!path) return [];

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new CatalogError(`failed to read ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new CatalogError(`${path}: invalid YAML — ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const root = parsed as Record<string, unknown>;
  const ws = root.workspace;
  if (!ws || typeof ws !== 'object') return [];
  const products = (ws as Record<string, unknown>).products;
  if (!Array.isArray(products)) return [];

  return products
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => {
      const id = typeof p.id === 'string' ? p.id : '';
      const description =
        typeof p.description === 'string' ? p.description : undefined;
      const sources = Array.isArray(p.contextSources)
        ? p.contextSources
            .filter(
              (s: unknown): s is Record<string, unknown> =>
                !!s && typeof s === 'object'
            )
            .map((s) => ({
              type: typeof s.type === 'string' ? s.type : '',
              target: typeof s.target === 'string' ? s.target : '',
              embedderUrl:
                typeof s.embedderUrl === 'string' ? s.embedderUrl : undefined,
              embedderModel:
                typeof s.embedderModel === 'string' ? s.embedderModel : undefined,
              embedderDim:
                typeof s.embedderDim === 'number' ? s.embedderDim : undefined,
              backend: typeof s.backend === 'string' ? s.backend : undefined,
            }))
        : undefined;
      const product: ProductDef = { id };
      if (description !== undefined) product.description = description;
      if (sources !== undefined) product.contextSources = sources;
      return product;
    })
    .filter((p) => p.id !== '');
}

/**
 * Convenience: wrap an inline Catalog as a loadCatalog function.
 * Useful for tests + the deprecated `catalog` constructor option.
 */
export function inlineCatalogLoader(catalog: Catalog): () => Promise<Catalog> {
  return () => Promise.resolve(catalog);
}

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

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AdapterId,
  type AgentDef,
  type Catalog,
  CatalogError,
  type Edge,
  type FlowDef,
  type ProductDef,
  type TaskStep,
  validateUnifiedCatalog,
} from '@ecruz165/harness-core';
import YAML from 'yaml';

/**
 * Local-dev catalog loader: stitches together
 *   - <workspaceRoot>/.harness/config/flows.json    → catalog.flows
 *   - <workspaceRoot>/harness-workspace.yml         → catalog.products
 * into one unified Catalog. Either source missing is fine — empty arrays.
 *
 * Failure modes:
 *   - JSON / YAML parse errors throw `CatalogError` with the file path
 *   - Schema mismatches throw `CatalogError` from validateUnifiedCatalog
 *   - Anything thrown at startup will fail-fast harness-server before it
 *     accepts traffic (per the rule: never serve with a partial catalog)
 */
export async function loadCatalogFromWorkspaceYaml(workspaceRoot: string): Promise<Catalog> {
  // Flows: workspace's flows.json may use the developer-friendly `phases`
  // shorthand (linear chain of agents) OR the canonical `nodes` + `edges`
  // shape directly. readWorkspaceFlows accepts both and produces FlowDef[].
  const flows = await readWorkspaceFlows(workspaceRoot);

  // Products come from harness-workspace.yml's per-product `contextSources`.
  const products = await readWorkspaceYamlProducts(workspaceRoot);

  const catalog: Catalog = { flows, products };
  validateUnifiedCatalog(catalog, '<merged-workspace-catalog>');
  return catalog;
}

/**
 * Read `<workspaceRoot>/.harness/config/flows.json` and produce FlowDef[].
 *
 * Two input shapes accepted:
 *   1. **Canonical** — flow has `nodes: TaskStep[]` and `edges: Edge[]`
 *      directly. Used as-is.
 *   2. **Phases shorthand** — flow has `phases: Phase[]`, a developer-
 *      friendly flat list. Auto-expanded into a linear chain:
 *      a manual trigger node → AgentStep node per phase → connected by
 *      sequence edges in the listed order.
 *
 * Phases-shorthand translation rules:
 *   phase.id              → node.config.agent.id
 *   phase.agent           → node.config.agent.adapter
 *                           ('claude-sdk' | 'opencode-cli')
 *   phase.description     → node.config.agent.role  (falls back to phase.id)
 *   phase.systemPrompt    → node.config.agent.systemPrompt
 *   phase.model           → node.config.agent.config.model
 *   phase.reasoningEffort → node.config.agent.config.reasoningEffort
 *   phase.tools           → node.config.agent.config.tools
 *
 * If a flow has canonical nodes+edges, use them directly. If both, prefer
 * canonical and ignore phases — explicit wins.
 *
 * Missing file → empty flows (matches harness-core's loadCatalog).
 * Malformed JSON or unknown adapter id → CatalogError with the file path.
 */
async function readWorkspaceFlows(workspaceRoot: string): Promise<FlowDef[]> {
  const path = join(workspaceRoot, '.harness', 'config', 'flows.json');
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
  if (!Array.isArray(root.flows)) {
    throw new CatalogError(`${path}: missing "flows" array`);
  }

  return root.flows.map((f: unknown, i: number) => {
    if (!f || typeof f !== 'object') {
      throw new CatalogError(`${path}: flows[${i}] must be an object`);
    }
    const flow = f as Record<string, unknown>;
    if (typeof flow.id !== 'string' || !flow.id) {
      throw new CatalogError(`${path}: flows[${i}].id must be a non-empty string`);
    }
    const description = typeof flow.description === 'string' ? flow.description : undefined;

    // Prefer canonical (nodes + edges) if present; else expand phases shorthand.
    const hasCanonical = Array.isArray(flow.nodes) && Array.isArray(flow.edges);
    const phases = !hasCanonical && Array.isArray(flow.phases) ? (flow.phases as unknown[]) : null;
    if (!hasCanonical && !phases) {
      throw new CatalogError(
        `${path}: flows[${i}] needs either "nodes"+"edges" or "phases" (got neither)`,
      );
    }

    let nodes: TaskStep[];
    let edges: Edge[];
    if (hasCanonical) {
      nodes = flow.nodes as TaskStep[];
      edges = flow.edges as Edge[];
    } else {
      // Expand phases → trigger + linear chain of agent nodes.
      if (phases!.length === 0) {
        throw new CatalogError(`${path}: flows[${i}].phases must be non-empty`);
      }
      const agents = phases!.map((ph, j) => phaseToAgent(ph, `${path}: flows[${i}].phases[${j}]`));
      const triggerId = '__trigger';
      nodes = [
        { id: triggerId, kind: 'trigger', config: { kind: 'manual' } },
        ...agents.map(
          (a): TaskStep => ({
            id: a.id,
            kind: 'agent',
            config: { agent: a },
          }),
        ),
      ];
      edges = [];
      let prev = triggerId;
      for (const a of agents) {
        edges.push({ from: prev, to: a.id, type: 'sequence' });
        prev = a.id;
      }
    }

    const def: FlowDef = { id: flow.id, nodes, edges };
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
      `${path}.agent must be "claude-sdk" or "opencode-cli" (got ${JSON.stringify(adapterRaw)})`,
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
    throw new CatalogError(`${path}.adapter must be "claude-sdk" or "opencode-cli"`);
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
async function readWorkspaceYamlProducts(workspaceRoot: string): Promise<ProductDef[]> {
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
      const description = typeof p.description === 'string' ? p.description : undefined;
      const sources = Array.isArray(p.contextSources)
        ? p.contextSources
            .filter((s: unknown): s is Record<string, unknown> => !!s && typeof s === 'object')
            .map((s) => ({
              type: typeof s.type === 'string' ? s.type : '',
              target: typeof s.target === 'string' ? s.target : '',
              embedderUrl: typeof s.embedderUrl === 'string' ? s.embedderUrl : undefined,
              embedderModel: typeof s.embedderModel === 'string' ? s.embedderModel : undefined,
              embedderDim: typeof s.embedderDim === 'number' ? s.embedderDim : undefined,
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

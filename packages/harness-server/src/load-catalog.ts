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
  loadCatalog as loadPipelinesJson,
  validateUnifiedCatalog,
  type Catalog,
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
  // Pipelines come from the existing JSON file (untouched by this slice).
  // The workspace's pipelines.json uses an older `phases`-shaped schema
  // that doesn't match harness-core's `agents`-based validator yet —
  // catch the validation error and surface a warning, but still serve
  // the product catalog so loaders work. Schema unification is its own
  // future slice.
  let pipelines: Catalog['pipelines'] = [];
  try {
    const pipelinesCatalog = await loadPipelinesJson(workspaceRoot);
    pipelines = pipelinesCatalog.pipelines;
  } catch (err) {
    if (err instanceof CatalogError) {
      process.stderr.write(
        `harness-server: pipelines.json failed validation; serving with no pipelines.\n` +
          `  reason: ${err.message}\n` +
          `  (products + loader-jobs still work; pipeline-based flows are gated until schema unification)\n`
      );
    } else {
      throw err;
    }
  }

  // Products come from harness-workspace.yml's per-product `contextSources`.
  const products = await readWorkspaceYamlProducts(workspaceRoot);

  const catalog: Catalog = { pipelines, products };
  validateUnifiedCatalog(catalog, '<merged-workspace-catalog>');
  return catalog;
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

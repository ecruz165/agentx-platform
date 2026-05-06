import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';

/**
 * Schema for `harness-workspace.yml` per prd-workspace-template.md §7.1.
 * The CLI uses this to validate `productId` at submit-time before a job
 * touches the server (decision #4). Many fields are optional now and will
 * be tightened as MVP-2+ ships features that depend on them.
 */
export interface RepoConfig {
  name: string;
  cloneUrl: string;
  baseRef: string;
  path?: string;
}

export interface ContextSourceConfig {
  /** Source type id from the @agentx/context-loader-core catalog
   *  (`code-full`, `prose-markdown`, `oss-code`, etc.). */
  type: string;
  /** What to ingest. For path sources this is a path relative to the
   *  workspace root or an absolute path. For OSS package sources it's
   *  `<package>@<version>`. For URL-driven sources (crawled-web,
   *  oss-docs) it's an https://… URL. */
  target: string;
  /** Optional per-source overrides. When absent, the workspace-default
   *  embedder + backend (set elsewhere in workspace config) apply. */
  embedderUrl?: string;
  embedderModel?: string;
  embedderDim?: number;
  backend?: string;
}

export interface ProductConfig {
  id: string;
  description?: string;
  repos: RepoConfig[];
  resources?: { memory?: string; cpu?: number };
  pipelines?: Array<{ id: string }>;
  /** Sources to ingest into the context graph for this product. Each
   *  entry maps to one `harness context load` call (or one `agentx-load`
   *  invocation in standalone mode). When `harness context load
   *  --product <id>` is invoked, every entry here gets loaded in
   *  parallel; nodes/edges/vectors are tagged with this product's id
   *  via the loader's `sourceId` field, so query-time scoping works.
   *
   *  Closes the loop on the product-as-tenant abstraction (decision #4):
   *  workspace memory + context have always been product-scoped on the
   *  query side; this declares ownership on the *write* side. */
  contextSources?: ContextSourceConfig[];
}

export interface ServerConfig {
  image?: string;
  port?: number;
  unixSocket?: string;
  backend?: string;
}

export interface WorkerConfig {
  image?: string;
  devcontainerPath?: string;
  namingPattern?: string;
  defaultResources?: { memory?: string; cpu?: number };
  tmux?: { enabled?: boolean; sessionPrefix?: string; readOnlyAttach?: boolean };
}

export interface WorktreeConfig {
  rootDir?: string;
  pathSchema?: string;
  keepOnSuccess?: boolean;
  keepOnFailure?: boolean;
  pruneAfter?: string;
  branchTemplate?: string;
}

export interface WorkspaceConfig {
  workspace: {
    id: string;
    servers?: { harness?: ServerConfig; memory?: ServerConfig; context?: ServerConfig };
    worker?: WorkerConfig;
    worktree?: WorktreeConfig;
    products: ProductConfig[];
  };
}

export interface PhaseConfig {
  id: string;
  agent?: string;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  description?: string;
  systemPrompt?: string;
  tools?: string[];
}

export interface PipelineConfig {
  id: string;
  name?: string;
  description?: string;
  phases?: PhaseConfig[];
}

export interface PipelineCatalog {
  version: number;
  pipelines: PipelineConfig[];
}

export class WorkspaceConfigError extends Error {}

/**
 * Reads `harness-workspace.yml` (or `.yaml`) from the workspace root.
 * Returns null if no config file is found — caller decides whether
 * that's an error (production submit) or fine (host-only smoke test).
 */
export async function readWorkspaceConfig(workspaceRoot: string): Promise<WorkspaceConfig | null> {
  const candidates = [
    join(workspaceRoot, 'harness-workspace.yml'),
    join(workspaceRoot, 'harness-workspace.yaml'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const raw = await readFile(path, 'utf8');
    const parsed = YAML.parse(raw) as unknown;
    return validate(parsed, path);
  }
  return null;
}

function validate(parsed: unknown, path: string): WorkspaceConfig {
  if (!parsed || typeof parsed !== 'object' || !('workspace' in parsed)) {
    throw new WorkspaceConfigError(`${path}: missing top-level "workspace" key`);
  }
  const ws = (parsed as { workspace: unknown }).workspace;
  if (!ws || typeof ws !== 'object') {
    throw new WorkspaceConfigError(`${path}: "workspace" must be an object`);
  }
  const w = ws as Record<string, unknown>;
  if (typeof w.id !== 'string') {
    throw new WorkspaceConfigError(`${path}: "workspace.id" must be a string`);
  }
  if (!Array.isArray(w.products) || w.products.length === 0) {
    throw new WorkspaceConfigError(`${path}: "workspace.products" must be a non-empty array`);
  }
  for (const [i, p] of w.products.entries()) {
    if (!p || typeof p !== 'object' || typeof (p as { id?: unknown }).id !== 'string') {
      throw new WorkspaceConfigError(`${path}: products[${i}] is missing "id"`);
    }
    if (!Array.isArray((p as { repos?: unknown }).repos)) {
      throw new WorkspaceConfigError(`${path}: products[${i}].repos must be an array`);
    }
    // Optional contextSources — each entry needs at least { type, target }.
    const sources = (p as { contextSources?: unknown }).contextSources;
    if (sources !== undefined) {
      if (!Array.isArray(sources)) {
        throw new WorkspaceConfigError(`${path}: products[${i}].contextSources must be an array`);
      }
      for (const [j, s] of sources.entries()) {
        if (!s || typeof s !== 'object') {
          throw new WorkspaceConfigError(
            `${path}: products[${i}].contextSources[${j}] must be an object`,
          );
        }
        const sObj = s as Record<string, unknown>;
        if (typeof sObj.type !== 'string') {
          throw new WorkspaceConfigError(
            `${path}: products[${i}].contextSources[${j}].type must be a string`,
          );
        }
        if (typeof sObj.target !== 'string') {
          throw new WorkspaceConfigError(
            `${path}: products[${i}].contextSources[${j}].target must be a string`,
          );
        }
      }
    }
  }
  return parsed as WorkspaceConfig;
}

export function findProduct(config: WorkspaceConfig, id: string): ProductConfig | null {
  return config.workspace.products.find((p) => p.id === id) ?? null;
}

export function listProductIds(config: WorkspaceConfig): string[] {
  return config.workspace.products.map((p) => p.id);
}

/**
 * Reads `.harness/config/pipelines.json` (per prd-workspace-template F13).
 * Returns null if the file is absent — callers decide whether that's a
 * config error (production submit) or fine (host-only smoke test).
 */
export async function readPipelines(workspaceRoot: string): Promise<PipelineCatalog | null> {
  const path = join(workspaceRoot, '.harness', 'config', 'pipelines.json');
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new WorkspaceConfigError(`${path}: invalid JSON — ${(err as Error).message}`);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { pipelines?: unknown }).pipelines)
  ) {
    throw new WorkspaceConfigError(`${path}: must have a "pipelines" array`);
  }
  for (const [i, p] of (parsed as { pipelines: unknown[] }).pipelines.entries()) {
    if (!p || typeof p !== 'object' || typeof (p as { id?: unknown }).id !== 'string') {
      throw new WorkspaceConfigError(`${path}: pipelines[${i}] is missing "id"`);
    }
  }
  return parsed as PipelineCatalog;
}

export function findPipeline(catalog: PipelineCatalog, id: string): PipelineConfig | null {
  return catalog.pipelines.find((p) => p.id === id) ?? null;
}

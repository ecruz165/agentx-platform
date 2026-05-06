/**
 * Provenance discovery for OSS dependencies.
 *
 * Reads a manifest file at the source root (today: package.json; future:
 * Cargo.toml, pom.xml, pyproject.toml) and projects it into Package +
 * Version nodes that the loader emits once per ingest. Each File node
 * later gets a BelongsTo edge into the Version, so downstream queries
 * can answer "which package version did this function come from?"
 *
 * Today this is JS/TS-only because the workspace's first OSS targets
 * are npm packages. Adding a manifest type is one new reader + one
 * dispatch case in `readOssPackageMeta`.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GraphEdge, GraphNode } from '../types.ts';

export interface OssPackageMeta {
  name: string;
  version: string;
  /** SPDX-style license expression when present in the manifest. */
  license?: string;
  /** Resolved repository URL when present. */
  repoUrl?: string;
  /** Manifest the metadata came from — useful in node properties for debugging. */
  manifest: string;
}

/** Try every supported manifest in order; first one that parses cleanly
 *  wins. Returns null when no manifest is found — callers decide whether
 *  to skip provenance emission or fail (loaders skip; admins can validate
 *  upstream). */
export async function readOssPackageMeta(rootPath: string): Promise<OssPackageMeta | null> {
  const candidates = [join(rootPath, 'package.json')];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const meta = await readPackageJson(path);
    if (meta) return meta;
  }
  return null;
}

async function readPackageJson(path: string): Promise<OssPackageMeta | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // Tolerated: we don't fail an ingest on a broken manifest
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== 'string' || !obj.name) return null;
  if (typeof obj.version !== 'string' || !obj.version) return null;

  const license = typeof obj.license === 'string' ? obj.license : undefined;
  // package.json's "repository" is sometimes a string, sometimes
  // { type, url }; both shapes appear in the wild.
  let repoUrl: string | undefined;
  const repo = obj.repository;
  if (typeof repo === 'string') {
    repoUrl = repo;
  } else if (repo && typeof repo === 'object') {
    const url = (repo as { url?: unknown }).url;
    if (typeof url === 'string') repoUrl = url;
  }

  return {
    name: obj.name,
    version: obj.version,
    license,
    repoUrl,
    manifest: 'package.json',
  };
}

/**
 * Project an `OssPackageMeta` into the graph nodes + edges the loader
 * should emit. Node ids are deterministic: `<name>` for Package,
 * `<name>@<version>` for Version. That way re-ingesting the same
 * package version is idempotent (existing nodes get updated via
 * MERGE in the backend; no duplicates).
 */
export function buildProvenanceGraph(
  meta: OssPackageMeta,
  sourceTypeId: string,
  sourceId: string,
): { nodes: GraphNode[]; edges: GraphEdge[]; versionNodeId: string } {
  const packageId = meta.name;
  const versionId = `${meta.name}@${meta.version}`;
  const license = meta.license;

  const nodes: GraphNode[] = [
    {
      id: packageId,
      label: 'Package',
      properties: {
        name: meta.name,
        ...(meta.repoUrl ? { repoUrl: meta.repoUrl } : {}),
      },
      sourceTypeId,
      sourceId,
      license,
    },
    {
      id: versionId,
      label: 'Version',
      properties: {
        name: meta.name,
        version: meta.version,
        manifest: meta.manifest,
        ...(meta.license ? { license: meta.license } : {}),
      },
      sourceTypeId,
      sourceId,
      license,
    },
  ];

  // Version → BelongsTo → Package: a Version belongs to its Package.
  // Lets queries traverse Package → all known Versions and back.
  const edges: GraphEdge[] = [
    {
      from: versionId,
      to: packageId,
      label: 'BelongsTo',
      sourceTypeId,
    },
  ];

  return { nodes, edges, versionNodeId: versionId };
}

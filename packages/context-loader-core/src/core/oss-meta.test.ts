/**
 * Tests for the oss-code provenance helpers and the integration with
 * ingest() that emits Package + Version + BelongsTo edges.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryGraphBackend } from '../backends/in-memory.ts';
import { ingest } from './ingest.ts';
import {
  readOssPackageMeta,
  buildProvenanceGraph,
} from './oss-meta.ts';
import type { EmbedderClient } from '../index.ts';

function mockEmbedder(dim = 8): EmbedderClient {
  let counter = 0;
  return {
    dim,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => {
        counter++;
        const v = new Float32Array(dim);
        for (let i = 0; i < dim; i++) v[i] = (counter * (i + 1)) % 7;
        return v;
      });
    },
  };
}

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'oss-meta-'));
});

describe('readOssPackageMeta', () => {
  it('returns null when no manifest is present', async () => {
    const meta = await readOssPackageMeta(workdir);
    expect(meta).toBeNull();
  });

  it('reads package.json with name + version', async () => {
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({
        name: 'fake-pkg',
        version: '1.2.3',
        license: 'MIT',
      })
    );
    const meta = await readOssPackageMeta(workdir);
    expect(meta).toEqual({
      name: 'fake-pkg',
      version: '1.2.3',
      license: 'MIT',
      manifest: 'package.json',
    });
  });

  it('extracts repository URL from string form', async () => {
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({
        name: 'p',
        version: '1.0.0',
        repository: 'https://github.com/x/p',
      })
    );
    const meta = await readOssPackageMeta(workdir);
    expect(meta!.repoUrl).toBe('https://github.com/x/p');
  });

  it('extracts repository URL from object form', async () => {
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({
        name: 'p',
        version: '1.0.0',
        repository: { type: 'git', url: 'git+https://github.com/x/p.git' },
      })
    );
    const meta = await readOssPackageMeta(workdir);
    expect(meta!.repoUrl).toBe('git+https://github.com/x/p.git');
  });

  it('returns null for malformed JSON (does not throw)', async () => {
    writeFileSync(join(workdir, 'package.json'), '{ not json');
    const meta = await readOssPackageMeta(workdir);
    expect(meta).toBeNull();
  });

  it('returns null when name or version is missing', async () => {
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({ description: 'no name no version' })
    );
    expect(await readOssPackageMeta(workdir)).toBeNull();
  });
});

describe('buildProvenanceGraph', () => {
  it('emits Package + Version nodes with deterministic ids', () => {
    const out = buildProvenanceGraph(
      { name: 'react', version: '18.2.0', license: 'MIT', manifest: 'package.json' },
      'oss-code',
      '/path/to/react'
    );
    expect(out.nodes).toHaveLength(2);
    const pkg = out.nodes.find((n) => n.label === 'Package')!;
    const ver = out.nodes.find((n) => n.label === 'Version')!;
    expect(pkg.id).toBe('react');
    expect(ver.id).toBe('react@18.2.0');
    expect(out.versionNodeId).toBe('react@18.2.0');
  });

  it('emits Version → BelongsTo → Package edge', () => {
    const out = buildProvenanceGraph(
      { name: 'react', version: '18.2.0', manifest: 'package.json' },
      'oss-code',
      '/'
    );
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toEqual({
      from: 'react@18.2.0',
      to: 'react',
      label: 'BelongsTo',
      sourceTypeId: 'oss-code',
    });
  });

  it('propagates license + repoUrl onto Version + Package node properties', () => {
    const out = buildProvenanceGraph(
      {
        name: 'react',
        version: '18.2.0',
        license: 'MIT',
        repoUrl: 'https://github.com/facebook/react',
        manifest: 'package.json',
      },
      'oss-code',
      '/'
    );
    const pkg = out.nodes.find((n) => n.label === 'Package')!;
    const ver = out.nodes.find((n) => n.label === 'Version')!;
    expect(pkg.properties.repoUrl).toBe('https://github.com/facebook/react');
    expect(pkg.license).toBe('MIT');
    expect(ver.properties.license).toBe('MIT');
    expect(ver.properties.version).toBe('18.2.0');
  });
});

describe('ingest() — oss-code provenance integration', () => {
  it('emits Package + Version once + OssFile → BelongsTo → Version per file', async () => {
    // Synthesize a tiny "OSS package" with two TS files.
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({ name: 'tiny-pkg', version: '0.1.0', license: 'MIT' })
    );
    mkdirSync(join(workdir, 'src'));
    writeFileSync(join(workdir, 'src', 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(workdir, 'src', 'b.ts'), 'export function b() { return 2; }\n');

    const backend = new InMemoryGraphBackend();
    await ingest({
      source: { type: 'oss-code', ref: { kind: 'path', path: workdir } },
      backend,
      embedderClient: mockEmbedder(8),
    });

    // Exactly one Package + one Version
    const packages = backend.nodesByLabel('Package');
    const versions = backend.nodesByLabel('Version');
    expect(packages).toHaveLength(1);
    expect(versions).toHaveLength(1);
    expect(packages[0]!.id).toBe('tiny-pkg');
    expect(versions[0]!.id).toBe('tiny-pkg@0.1.0');

    // Two OssFiles, each with a BelongsTo edge into the Version
    const files = backend.nodesByLabel('OssFile');
    expect(files).toHaveLength(2);
    const belongsTo = backend.edgesByLabel('BelongsTo');
    // 1 (Version → Package) + 2 (each OssFile → Version) = 3 edges
    expect(belongsTo).toHaveLength(3);
    const fileEdges = belongsTo.filter((e) => e.to === 'tiny-pkg@0.1.0');
    expect(fileEdges).toHaveLength(2);
    const fileEdgeFromIds = fileEdges.map((e) => e.from).sort();
    expect(fileEdgeFromIds).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('skips provenance gracefully when no package.json is present', async () => {
    // No manifest. Other oss-code tests have already verified the
    // chunker emits OssFile nodes; this just checks we don't crash
    // and that no Package/Version nodes appear.
    mkdirSync(join(workdir, 'src'));
    writeFileSync(join(workdir, 'src', 'orphan.ts'), 'export function orphan() {}\n');
    const backend = new InMemoryGraphBackend();
    const summary = await ingest({
      source: { type: 'oss-code', ref: { kind: 'path', path: workdir } },
      backend,
      embedderClient: mockEmbedder(8),
    });
    expect(summary.errors).toBe(0);
    expect(backend.nodesByLabel('Package')).toHaveLength(0);
    expect(backend.nodesByLabel('Version')).toHaveLength(0);
    // OssFile still emitted; just no provenance edges into it.
    expect(backend.nodesByLabel('OssFile').length).toBeGreaterThan(0);
  });

  it('does NOT emit Package/Version for code-full source type', async () => {
    // Even with a package.json present, code-full skips provenance —
    // first-party code doesn't have a "version we depend on" story.
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({ name: 'x', version: '1.0.0' })
    );
    mkdirSync(join(workdir, 'src'));
    writeFileSync(join(workdir, 'src', 'a.ts'), 'export function a() {}\n');

    const backend = new InMemoryGraphBackend();
    await ingest({
      source: { type: 'code-full', ref: { kind: 'path', path: workdir } },
      backend,
      embedderClient: mockEmbedder(8),
    });
    expect(backend.nodesByLabel('Package')).toHaveLength(0);
    expect(backend.nodesByLabel('Version')).toHaveLength(0);
    // code-full keeps canonical labels (no Oss prefix).
    expect(backend.nodesByLabel('File').length).toBeGreaterThan(0);
  });
});

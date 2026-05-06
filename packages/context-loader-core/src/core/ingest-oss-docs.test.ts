/**
 * Tests for the path-based oss-docs source type.
 *
 * Synthesizes a tiny "OSS package" with a docs/ directory + package.json
 * and runs ingest. Asserts:
 *  - heading-based chunker honors labelPrefix → emits OssDoc + OssSection
 *  - oss-package provenance fires for oss-docs (same as oss-code)
 *  - the BelongsTo edge from each OssDoc ties it back to the Version
 *  - prose-markdown is unaffected (still emits plain Doc/Section)
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryGraphBackend } from '../backends/in-memory.ts';
import type { EmbedderClient } from '../index.ts';
import { ingest } from './ingest.ts';

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
  workdir = mkdtempSync(join(tmpdir(), 'oss-docs-test-'));
});

describe('ingest() — oss-docs (path-based)', () => {
  it('emits OssDoc + OssSection labels with package provenance', async () => {
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({ name: 'fake-pkg', version: '2.0.0', license: 'Apache-2.0' }),
    );
    mkdirSync(join(workdir, 'docs'));
    writeFileSync(
      join(workdir, 'docs', 'getting-started.md'),
      '# Getting Started\n\nIntro text.\n\n## Install\n\nrun the install.\n\n## Usage\n\ncall the api.\n',
    );
    writeFileSync(
      join(workdir, 'docs', 'api.md'),
      '# API\n\n## fooFn\n\nDoes the foo.\n\n## barFn\n\nDoes the bar.\n',
    );

    const backend = new InMemoryGraphBackend();
    await ingest({
      source: { type: 'oss-docs', ref: { kind: 'path', path: workdir } },
      backend,
      embedderClient: mockEmbedder(8),
    });

    // Schema: OssDoc + OssSection (heading-based with labelPrefix='Oss')
    const docs = backend.nodesByLabel('OssDoc');
    const sections = backend.nodesByLabel('OssSection');
    expect(docs.length).toBeGreaterThan(0);
    expect(sections.length).toBeGreaterThan(0);
    // No plain Doc/Section labels under oss-docs.
    expect(backend.nodesByLabel('Doc')).toHaveLength(0);
    expect(backend.nodesByLabel('Section')).toHaveLength(0);

    // Provenance: 1 Package + 1 Version emitted once.
    expect(backend.nodesByLabel('Package')).toHaveLength(1);
    expect(backend.nodesByLabel('Version')).toHaveLength(1);
    expect(backend.nodesByLabel('Version')[0]!.id).toBe('fake-pkg@2.0.0');

    // BelongsTo edges:
    //   - 1 Version → Package
    //   - 1 per OssDoc → Version (2 docs in this fixture)
    const belongsTo = backend.edgesByLabel('BelongsTo');
    expect(belongsTo).toHaveLength(3);
    const docToVersion = belongsTo.filter((e) => e.to === 'fake-pkg@2.0.0');
    expect(docToVersion).toHaveLength(2);
    expect(docToVersion.map((e) => e.from).sort()).toEqual([
      'docs/api.md',
      'docs/getting-started.md',
    ]);
  });

  it('skips provenance when no package.json present', async () => {
    mkdirSync(join(workdir, 'docs'));
    writeFileSync(join(workdir, 'docs', 'orphan.md'), '# Orphan\n\ntext\n');

    const backend = new InMemoryGraphBackend();
    const summary = await ingest({
      source: { type: 'oss-docs', ref: { kind: 'path', path: workdir } },
      backend,
      embedderClient: mockEmbedder(8),
    });
    expect(summary.errors).toBe(0);
    expect(backend.nodesByLabel('Package')).toHaveLength(0);
    expect(backend.nodesByLabel('Version')).toHaveLength(0);
    // OssDoc still emitted; just no provenance edges into it.
    expect(backend.nodesByLabel('OssDoc').length).toBeGreaterThan(0);
  });

  it('prose-markdown stays on canonical Doc/Section labels (no prefix)', async () => {
    // Workspace prose should NOT be relabeled by the oss-docs work.
    writeFileSync(join(workdir, 'README.md'), '# Workspace\n\n## Setup\n\nstuff\n');

    const backend = new InMemoryGraphBackend();
    await ingest({
      source: { type: 'prose-markdown', ref: { kind: 'path', path: workdir } },
      backend,
      embedderClient: mockEmbedder(8),
    });
    expect(backend.nodesByLabel('Doc').length).toBeGreaterThan(0);
    expect(backend.nodesByLabel('OssDoc')).toHaveLength(0);
    expect(backend.nodesByLabel('Package')).toHaveLength(0);
  });
});

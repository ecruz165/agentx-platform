/**
 * Unit + integration tests for the whole-file chunker.
 *
 * The chunker itself is small (one node per file). The tests cover:
 *  - title extraction (first H1 vs filename fallback)
 *  - end-to-end ingest of a fixture learnings directory through the
 *    catalog's `learned` source type, verifying Learning nodes land
 *    with the right shape
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryGraphBackend } from '../../backends/in-memory.ts';
import type { EmbedderClient } from '../../index.ts';
import { ingest } from '../ingest.ts';
import { chunkWholeFile } from './whole-file.ts';

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

describe('chunkWholeFile', () => {
  it('emits exactly one node + one chunk for the input', () => {
    const out = chunkWholeFile({
      docId: 'lessons/auth-mocking.md',
      content: '# Auth mocking burned us\n\nDont mock the database.\n',
      sourceTypeId: 'learned',
      sourceId: 'job-abc',
    });
    expect(out.nodes).toHaveLength(1);
    expect(out.chunks).toHaveLength(1);
    expect(out.edges).toHaveLength(0);
    expect(out.nodes[0]!.id).toBe('lessons/auth-mocking.md');
    expect(out.nodes[0]!.label).toBe('Learning');
  });

  it('extracts title from the first H1', () => {
    const out = chunkWholeFile({
      docId: 'a.md',
      content: '# Real title\n\nbody\n',
      sourceTypeId: 'learned',
      sourceId: 'ws',
    });
    expect(out.nodes[0]!.properties.title).toBe('Real title');
  });

  it('falls back to a clean filename when no H1 is present', () => {
    const out = chunkWholeFile({
      docId: 'lessons/no-heading.md',
      content: 'just text, no heading at all\n',
      sourceTypeId: 'learned',
      sourceId: 'ws',
    });
    expect(out.nodes[0]!.properties.title).toBe('no-heading');
  });

  it('puts the full content on the node and into the chunk', () => {
    const content = '# T\n\nthe content\n';
    const out = chunkWholeFile({
      docId: 'x.md',
      content,
      sourceTypeId: 'learned',
      sourceId: 'ws',
    });
    expect(out.nodes[0]!.properties.text).toBe(content);
    expect(out.nodes[0]!.properties.chars).toBe(content.length);
    expect(out.chunks[0]!.text).toBe(content);
  });

  it('honors a custom label override', () => {
    const out = chunkWholeFile({
      docId: 'y.md',
      content: 'x',
      sourceTypeId: 'summary',
      sourceId: 'ws',
      label: 'Summary',
    });
    expect(out.nodes[0]!.label).toBe('Summary');
  });
});

describe('ingest() — learned source type (whole-file dispatch)', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'learned-test-'));
    // Three fixture learnings — diverse formats to exercise title
    // extraction + content sizing.
    mkdirSync(join(workdir, 'lessons'));
    writeFileSync(
      join(workdir, 'lessons', 'auth-mock.md'),
      '# Auth mocking burned us\n\nDont mock the database in integration tests.\n',
    );
    writeFileSync(
      join(workdir, 'lessons', 'tui-dims.md'),
      '# OpenTUI useTerminalDimensions returns {0, 0} on first render\n\nUse a fallback hook.\n',
    );
    writeFileSync(
      join(workdir, 'lessons', 'untitled.md'),
      'no heading; should fall back to filename for title\n',
    );
  });

  it('ingests each .md file as a Learning node', async () => {
    const backend = new InMemoryGraphBackend();
    const summary = await ingest({
      source: { type: 'learned', ref: { kind: 'path', path: workdir } },
      backend,
      embedderClient: mockEmbedder(8),
    });

    expect(summary.errors).toBe(0);
    expect(summary.filesIngested).toBe(3);

    const learnings = backend.nodesByLabel('Learning');
    expect(learnings).toHaveLength(3);
    const titles = learnings.map((n) => n.properties.title).sort();
    expect(titles).toEqual([
      'Auth mocking burned us',
      'OpenTUI useTerminalDimensions returns {0, 0} on first render',
      'untitled',
    ]);
  });

  it('vector count equals chunk count (one per file)', async () => {
    const backend = new InMemoryGraphBackend();
    const summary = await ingest({
      source: { type: 'learned', ref: { kind: 'path', path: workdir } },
      backend,
      embedderClient: mockEmbedder(8),
    });
    expect(summary.vectorsWritten).toBe(summary.chunksWritten);
    expect(summary.vectorsWritten).toBe(3);
  });

  it('emits no edges (Learning nodes are leaves until cross-link runs)', async () => {
    const backend = new InMemoryGraphBackend();
    await ingest({
      source: { type: 'learned', ref: { kind: 'path', path: workdir } },
      backend,
      embedderClient: mockEmbedder(8),
    });
    // No Contains, LinkedFrom, BelongsTo, etc. — until checkout-coordinator
    // runs and emits DerivedFrom/RelatedTo, Learnings stand alone.
    expect(backend.edges.size).toBe(0);
  });
});

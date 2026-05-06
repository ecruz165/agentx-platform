import { describe, expect, it } from 'vitest';
import { chunkHeadingBased } from './heading-based.ts';

describe('chunkHeadingBased', () => {
  it('emits one Doc node + one Section node per H1/H2', () => {
    const md = `# Title

intro paragraph

## First section

content of first

## Second section

content of second
`;
    const out = chunkHeadingBased({
      docId: 'guide.md',
      content: md,
      sourceTypeId: 'prose-markdown',
      sourceId: 'workspace',
    });

    const docs = out.nodes.filter((n) => n.label === 'Doc');
    const sections = out.nodes.filter((n) => n.label === 'Section');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.id).toBe('guide.md');
    expect(docs[0]!.properties.title).toBe('Title');

    // 3 sections: the H1 itself, plus the two H2s.
    expect(sections).toHaveLength(3);
    expect(sections.map((s) => s.properties.heading)).toEqual([
      'Title',
      'First section',
      'Second section',
    ]);
  });

  it('emits a Contains edge from doc to each section', () => {
    const md = `# Doc\n\n## A\n\ntext\n\n## B\n\ntext\n`;
    const out = chunkHeadingBased({
      docId: 'd.md',
      content: md,
      sourceTypeId: 'prose-markdown',
      sourceId: 'ws',
    });
    const containsEdges = out.edges.filter((e) => e.label === 'Contains');
    // 3 sections (H1 + 2 H2s) → 3 Contains edges
    expect(containsEdges).toHaveLength(3);
    for (const e of containsEdges) {
      expect(e.from).toBe('d.md');
      expect(e.to.startsWith('d.md#section-')).toBe(true);
    }
  });

  it('extracts inline markdown links as LinkedFrom edges', () => {
    const md = `# A\n\nSee [other](other.md) and [external](https://example.com).\n`;
    const out = chunkHeadingBased({
      docId: 'a.md',
      content: md,
      sourceTypeId: 'prose-markdown',
      sourceId: 'ws',
    });
    const linkedFrom = out.edges.filter((e) => e.label === 'LinkedFrom');
    expect(linkedFrom.map((e) => e.to)).toEqual(['other.md', 'https://example.com']);
  });

  it('produces one chunk text per section node, in order', () => {
    const md = `# T\n\nintro\n\n## S1\n\nbody1\n\n## S2\n\nbody2\n`;
    const out = chunkHeadingBased({
      docId: 't.md',
      content: md,
      sourceTypeId: 'prose-markdown',
      sourceId: 'ws',
    });
    expect(out.chunks).toHaveLength(3);
    expect(out.chunks[0]!.text).toContain('intro');
    expect(out.chunks[1]!.text).toContain('body1');
    expect(out.chunks[2]!.text).toContain('body2');
  });

  it('subdivides a too-large section with overlap', () => {
    // 10K chars at maxTokens=100 (~400 chars) → multiple sub-chunks
    const longBody = 'word '.repeat(2000);
    const md = `# T\n\n## Big\n\n${longBody}\n`;
    const out = chunkHeadingBased({
      docId: 't.md',
      content: md,
      sourceTypeId: 'prose-markdown',
      sourceId: 'ws',
      maxTokens: 100,
      overlapTokens: 10,
    });
    const sectionsForBig = out.nodes.filter(
      (n) => n.label === 'Section' && n.properties.heading === 'Big',
    );
    expect(sectionsForBig.length).toBeGreaterThan(1);
  });

  it('falls back to docId when no H1 and no title given', () => {
    const md = `Just some text without a heading.\n`;
    const out = chunkHeadingBased({
      docId: 'plain.md',
      content: md,
      sourceTypeId: 'prose-markdown',
      sourceId: 'ws',
    });
    expect(out.nodes[0]!.properties.title).toBe('plain.md');
  });
});

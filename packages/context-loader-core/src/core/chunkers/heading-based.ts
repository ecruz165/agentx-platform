/**
 * Heading-based chunker for prose-markdown / crawled-web source types.
 *
 * Splits a markdown document into sections at H1/H2 boundaries. Each section
 * becomes one chunk. Sections longer than `maxTokens` (rough char-based
 * approximation) are sub-split with overlap so retrieval can land on the
 * right neighborhood.
 *
 * Tokens are estimated as `chars / 4` — close enough for chunk sizing
 * decisions without pulling in a tokenizer dependency. The embedder will
 * apply real tokenization at request time.
 *
 * Output:
 *   - Each top-level section produces one Section node + Doc edge.
 *   - The document itself produces one Doc node.
 *   - LinkedFrom edges are extracted from inline markdown links.
 */

import type { GraphEdge, GraphNode } from '../../types.ts';

const APPROX_CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_OVERLAP_TOKENS = 128;

export interface ChunkInput {
  /** Stable id for the source doc (e.g., file path or URL). */
  docId: string;
  /** Document title (from frontmatter or first H1; falls back to filename). */
  title?: string;
  /** Raw markdown content. */
  content: string;
  /** Source type id producing these chunks (for graph node tagging). */
  sourceTypeId: string;
  /** Logical source id (workspace/package/version). */
  sourceId: string;
  /** Per-chunk size config. */
  maxTokens?: number;
  overlapTokens?: number;
  /**
   * Optional prefix prepended to emitted node labels (Doc → OssDoc,
   * Section → OssSection). Mirrors the tree-sitter chunker's
   * labelPrefix from C.3. Edge labels (Contains, LinkedFrom) stay
   * un-prefixed — same convention as tree-sitter.
   */
  labelPrefix?: string;
}

export interface ChunkOutput {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Per-chunk text, in declaration order. The embedder vectorizes these. */
  chunks: Array<{ nodeId: string; text: string }>;
}

/**
 * Public API: chunk a markdown document.
 *
 * The output's `chunks` array maps 1:1 to nodes labeled `Section`.
 * The Doc node is at nodes[0]; sections start at nodes[1].
 */
export function chunkHeadingBased(input: ChunkInput): ChunkOutput {
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapTokens = input.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  const maxChars = maxTokens * APPROX_CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * APPROX_CHARS_PER_TOKEN;

  const labelPrefix = input.labelPrefix ?? '';
  const docTitle = input.title ?? extractFirstH1(input.content) ?? input.docId;
  const docNode: GraphNode = {
    id: input.docId,
    label: `${labelPrefix}Doc`,
    properties: { title: docTitle, sourceTypeId: input.sourceTypeId },
    sourceTypeId: input.sourceTypeId,
    sourceId: input.sourceId,
  };

  const sections = splitByHeading(input.content);
  const nodes: GraphNode[] = [docNode];
  const edges: GraphEdge[] = [];
  const chunks: Array<{ nodeId: string; text: string }> = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const sectionPieces =
      section.text.length > maxChars
        ? splitWithOverlap(section.text, maxChars, overlapChars)
        : [section.text];

    for (let pieceIdx = 0; pieceIdx < sectionPieces.length; pieceIdx++) {
      const piece = sectionPieces[pieceIdx]!;
      const sectionId = `${input.docId}#section-${i}${
        sectionPieces.length > 1 ? `-${pieceIdx}` : ''
      }`;
      const sectionNode: GraphNode = {
        id: sectionId,
        label: `${labelPrefix}Section`,
        properties: {
          heading: section.heading ?? '(intro)',
          level: section.level,
          ordinal: i,
          subOrdinal: pieceIdx,
          chars: piece.length,
          // Chunk text on the node — used for symbol-resolution
          // queries (Phase C.7 Documents edges) and as content payload
          // for query-result rendering. Bounded by maxChars from
          // splitWithOverlap, so well under Neo4j's property size limit.
          text: piece,
        },
        sourceTypeId: input.sourceTypeId,
        sourceId: input.sourceId,
      };
      nodes.push(sectionNode);
      edges.push({
        from: input.docId,
        to: sectionId,
        label: 'Contains',
        sourceTypeId: input.sourceTypeId,
      });
      chunks.push({ nodeId: sectionId, text: piece });
    }
  }

  // Inline links → LinkedFrom edges (best-effort; targets may not yet exist
  // in the graph, but content-hash dedup handles both orders).
  for (const target of extractMarkdownLinks(input.content)) {
    edges.push({
      from: input.docId,
      to: target,
      label: 'LinkedFrom',
      sourceTypeId: input.sourceTypeId,
    });
  }

  return { nodes, edges, chunks };
}

// ─── pure helpers ────────────────────────────────────────────────────────

interface RawSection {
  heading: string | null;
  level: number;
  text: string;
}

function splitByHeading(md: string): RawSection[] {
  const lines = md.split('\n');
  const sections: RawSection[] = [];
  let current: RawSection = { heading: null, level: 0, text: '' };

  for (const line of lines) {
    const m = /^(#{1,2})\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (current.text.trim() || current.heading) sections.push(current);
      current = { heading: m[2]!, level: m[1]!.length, text: line + '\n' };
    } else {
      current.text += line + '\n';
    }
  }
  if (current.text.trim() || current.heading) sections.push(current);

  return sections.map((s) => ({ ...s, text: s.text.trimEnd() }));
}

function splitWithOverlap(text: string, maxChars: number, overlapChars: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    out.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - overlapChars;
    if (start < 0) start = 0;
  }
  return out;
}

function extractFirstH1(md: string): string | null {
  const m = /^#\s+(.+?)\s*$/m.exec(md);
  return m ? m[1]! : null;
}

function extractMarkdownLinks(md: string): string[] {
  const out: string[] = [];
  const re = /\[[^\]]*\]\(([^)\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

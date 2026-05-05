/**
 * Whole-file chunker — one node per file, the file's content is the
 * chunk. Used by the `learned` source type (per the catalog) and any
 * future source types where the right granularity is "the document is
 * the unit of meaning."
 *
 * Why not heading-based for `learned`?
 *   A "learning" is an atomic piece of distilled wisdom from a job —
 *   "auth tests should hit a real database, mocking burned us last
 *   quarter." Splitting it by markdown headings would shatter a single
 *   coherent thought across multiple Section nodes. One file = one
 *   Learning matches the conceptual unit.
 *
 * Title extraction: first H1 line (or the filename if absent) becomes
 * the node's `title` property. Useful for TUI display + dashboards.
 *
 * No edges emitted by this chunker. The DerivedFrom / RelatedTo edges
 * that the `learned` schema declares come from cross-source-type
 * linking (similar to Documents in C.7) — a Phase D+ slice when the
 * checkout-coordinator actually fires and we know which jobId
 * "derived" each learning.
 */

import type { GraphEdge, GraphNode } from '../../types.ts';

export interface WholeFileChunkInput {
  /** Stable id for the file. Typically a relative path. */
  docId: string;
  /** The file's full content. */
  content: string;
  /** Source type id producing this chunk (for graph node tagging). */
  sourceTypeId: string;
  /** Logical source id (workspace / job / package context). */
  sourceId: string;
  /** Optional license tag — passes through unchanged onto the node. */
  license?: string;
  /**
   * Node label for the emitted chunk node. Defaults to 'Learning'
   * (matches the `learned` source type's schema). A future use case
   * (e.g., a `summary` source type) could override this.
   */
  label?: string;
}

export interface WholeFileChunkOutput {
  nodes: GraphNode[];
  edges: GraphEdge[];
  chunks: Array<{ nodeId: string; text: string }>;
}

const FIRST_H1 = /^\s*#\s+(.+?)\s*$/m;

export function chunkWholeFile(input: WholeFileChunkInput): WholeFileChunkOutput {
  const label = input.label ?? 'Learning';
  const titleFromH1 = FIRST_H1.exec(input.content)?.[1];
  const title =
    titleFromH1 ?? input.docId.replace(/^.*\//, '').replace(/\.\w+$/, '');

  const node: GraphNode = {
    id: input.docId,
    label,
    properties: {
      title,
      chars: input.content.length,
      // Chunk text on the node — same purpose as in heading-based +
      // tree-sitter (Phase C.7 query / cross-link payload).
      text: input.content,
    },
    sourceTypeId: input.sourceTypeId,
    sourceId: input.sourceId,
    license: input.license,
  };

  return {
    nodes: [node],
    edges: [],
    chunks: [{ nodeId: input.docId, text: input.content }],
  };
}

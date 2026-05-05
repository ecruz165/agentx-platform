import type {
  GraphEdge,
  GraphIngestionBackend,
  GraphNode,
  SourceTypeSchema,
} from '../types.ts';

/**
 * In-memory test backend for the context loader's graph ingestion path.
 *
 * **Not related to `@agentx/edge-memory-server`** — that's per-job ephemeral
 * scratch backed by SQLite + sqlite-vec, with a different interface
 * (MemoryStore) and a different lifecycle. This class implements
 * `GraphIngestionBackend` (graph nodes/edges/vectors) and lives in JS Maps
 * for the duration of one process. The naming uses "Graph" explicitly to
 * keep that boundary clear.
 *
 * Useful for:
 *   - Phase B unit tests where spinning up Kuzu/Neo4j is overkill
 *   - Programmatic consumers that only want short-lived in-process graphs
 *   - Validating chunker / matcher logic without backend round-trips
 *
 * Idempotency is content-hash-keyed at the node level (ids are the keys).
 * Edges are keyed by (from, to, label) so concurrent emissions of the
 * same edge converge.
 *
 * NOT for production. No persistence, no multi-process safety, no vector
 * index — `searchVectors` is a brute-force cosine scan suitable for tests
 * with small N only.
 */
export class InMemoryGraphBackend implements GraphIngestionBackend {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();
  readonly vectors = new Map<
    string,
    { vector: Float32Array; meta: Record<string, unknown> }
  >();
  readonly schemas: SourceTypeSchema[] = [];

  async upsertNode(node: GraphNode): Promise<void> {
    this.nodes.set(node.id, node);
  }

  async upsertEdge(edge: GraphEdge): Promise<void> {
    const key = `${edge.from}|${edge.to}|${edge.label}`;
    this.edges.set(key, edge);
  }

  async upsertVector(
    nodeId: string,
    vector: Float32Array,
    meta: Record<string, unknown>
  ): Promise<void> {
    this.vectors.set(nodeId, { vector, meta });
  }

  async upsertNodesBulk(nodes: GraphNode[]): Promise<void> {
    for (const n of nodes) await this.upsertNode(n);
  }

  async upsertEdgesBulk(edges: GraphEdge[]): Promise<void> {
    for (const e of edges) await this.upsertEdge(e);
  }

  async upsertVectorsBulk(
    items: Array<{
      nodeId: string;
      vector: Float32Array;
      meta: Record<string, unknown>;
    }>
  ): Promise<void> {
    for (const it of items) await this.upsertVector(it.nodeId, it.vector, it.meta);
  }

  async ensureSchema(schema: SourceTypeSchema): Promise<void> {
    this.schemas.push(schema);
  }

  async close(): Promise<void> {
    // no-op
  }

  // ── Test helpers (not part of GraphIngestionBackend) ─────────────────

  /** Total node count across all source types. */
  nodeCount(): number {
    return this.nodes.size;
  }

  /** Nodes filtered by label. */
  nodesByLabel(label: string): GraphNode[] {
    return [...this.nodes.values()].filter((n) => n.label === label);
  }

  /** Edges filtered by label. */
  edgesByLabel(label: string): GraphEdge[] {
    return [...this.edges.values()].filter((e) => e.label === label);
  }

  /** Brute-force cosine top-K over stored vectors. Test-only — O(N). */
  searchVectors(query: Float32Array, k = 5): Array<{ nodeId: string; score: number }> {
    const out: Array<{ nodeId: string; score: number }> = [];
    for (const [nodeId, { vector }] of this.vectors) {
      out.push({ nodeId, score: cosine(query, vector) });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, k);
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

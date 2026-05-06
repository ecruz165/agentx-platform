/**
 * Neo4j-backed GraphIngestionBackend — the single production backend.
 *
 * Used by both the local edge tier (`bolt://neo4j-edge:7687` in compose)
 * and the deployed central tier (Bolt to the ECS-hosted Neo4j Community
 * task). Same code, different URLs. See workspace memory
 * `project_central_graph_store_choice` for the engine choice.
 *
 * Translation contract:
 *   GraphNode    → MERGE (n:`Label` {id: row.id}) SET n += row.props
 *   GraphEdge    → MATCH (a {id: row.from}), (b {id: row.to})
 *                  MERGE (a)-[r:`Label`]->(b) SET r += row.props
 *   vector       → MATCH (n {id: row.nodeId}) SET n.embedding = row.vector
 *
 * Schema DDL (idempotent, runs once per source type):
 *   CREATE CONSTRAINT … FOR (n:`Label`) REQUIRE n.id IS UNIQUE
 *   CREATE VECTOR INDEX `<Label>_vec_idx` IF NOT EXISTS …
 *     OPTIONS { indexConfig: { 'vector.dimensions': 1024,
 *                              'vector.similarity_function': 'cosine' } }
 *
 * Cypher-injection note: Neo4j does not allow parameterizing labels or
 * relationship types — they must be in the query string. We validate
 * label strings against /^[A-Za-z_][A-Za-z0-9_]*$/ before splicing them
 * into Cypher; anything else throws. Properties go through driver
 * parameters and are never spliced.
 */

import neo4j, { type Driver, type Config as Neo4jConfig, type Session } from 'neo4j-driver';
import type { GraphEdge, GraphIngestionBackend, GraphNode, SourceTypeSchema } from '../types.ts';

export interface Neo4jBackendOptions {
  /** Bolt URL — e.g., bolt://neo4j-edge:7687 or neo4j+s://… */
  url: string;
  /** Auth username. Defaults to 'neo4j'. */
  user?: string;
  /** Auth password. */
  password: string;
  /** Database name. Community Edition has only 'neo4j'; pass through anyway for forward-compat with Enterprise. */
  database?: string;
  /** Vector dimension declared in schema DDL. Must match the embedder's dim. */
  vectorDim?: number;
  /** Distance metric for vector indexes. */
  vectorSimilarity?: 'cosine' | 'euclidean';
  /** Driver-level config passthrough (timeouts, logging, etc.). */
  driverConfig?: Neo4jConfig;
}

/** Reject anything that isn't a valid Cypher identifier. Prevents Cypher injection
 *  via the label channel (the one channel where parameters don't work). */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertSafeLabel(label: string, kind: 'node' | 'edge'): void {
  if (!SAFE_IDENT.test(label)) {
    throw new Error(
      `Neo4jBackend: invalid ${kind} label '${label}'. Labels must match /^[A-Za-z_][A-Za-z0-9_]*$/.`,
    );
  }
}

export class Neo4jBackend implements GraphIngestionBackend {
  private readonly driver: Driver;
  private readonly database: string;
  private readonly vectorDim: number;
  private readonly vectorSimilarity: 'cosine' | 'euclidean';

  constructor(opts: Neo4jBackendOptions) {
    const auth = neo4j.auth.basic(opts.user ?? 'neo4j', opts.password);
    this.driver = neo4j.driver(opts.url, auth, opts.driverConfig);
    this.database = opts.database ?? 'neo4j';
    this.vectorDim = opts.vectorDim ?? 1024;
    this.vectorSimilarity = opts.vectorSimilarity ?? 'cosine';
  }

  async ensureSchema(schema: SourceTypeSchema): Promise<void> {
    const session = this.session();
    try {
      for (const label of schema.nodes) {
        assertSafeLabel(label, 'node');
        // Uniqueness constraint on .id — also serves as a btree-style lookup
        // index, so MERGE-by-id stays O(log n) rather than scanning.
        await session.run(
          `CREATE CONSTRAINT \`${label}_id_unique\` IF NOT EXISTS
           FOR (n:\`${label}\`) REQUIRE n.id IS UNIQUE`,
        );
        // Vector index on .embedding. Idempotent: IF NOT EXISTS guards
        // against re-creation on subsequent runs.
        //
        // `vector.dimensions` MUST be an integer at the Cypher type level —
        // Neo4j rejects floats for this config key. JS numbers default to
        // FLOAT in the driver, so we wrap in neo4j.int() to force INTEGER.
        await session.run(
          `CREATE VECTOR INDEX \`${label}_vec_idx\` IF NOT EXISTS
           FOR (n:\`${label}\`) ON (n.embedding)
           OPTIONS { indexConfig: {
             \`vector.dimensions\`: $dim,
             \`vector.similarity_function\`: $sim
           } }`,
          { dim: neo4j.int(this.vectorDim), sim: this.vectorSimilarity },
        );
      }
      // Edge labels don't need explicit DDL in Neo4j — they're created
      // implicitly on first MERGE. We still validate them now so callers
      // get an early error rather than a Cypher-parse error mid-ingest.
      for (const label of schema.edges) assertSafeLabel(label, 'edge');
    } finally {
      await session.close();
    }
  }

  async upsertNode(node: GraphNode): Promise<void> {
    return this.upsertNodesBulk([node]);
  }

  async upsertNodesBulk(nodes: GraphNode[]): Promise<void> {
    if (nodes.length === 0) return;
    // Group by label — Cypher can't parameterize labels, so we issue one
    // query per distinct label.
    const byLabel = new Map<string, GraphNode[]>();
    for (const n of nodes) {
      assertSafeLabel(n.label, 'node');
      const bucket = byLabel.get(n.label) ?? [];
      bucket.push(n);
      byLabel.set(n.label, bucket);
    }
    const session = this.session();
    try {
      for (const [label, group] of byLabel) {
        await session.executeWrite((tx) =>
          tx.run(
            `UNWIND $rows AS row
             MERGE (n:\`${label}\` {id: row.id})
             SET n += row.props,
                 n.sourceTypeId = row.sourceTypeId,
                 n.sourceId = row.sourceId,
                 n.license = row.license`,
            { rows: group.map(serializeNode) },
          ),
        );
      }
    } finally {
      await session.close();
    }
  }

  async upsertEdge(edge: GraphEdge): Promise<void> {
    return this.upsertEdgesBulk([edge]);
  }

  async upsertEdgesBulk(edges: GraphEdge[]): Promise<void> {
    if (edges.length === 0) return;
    const byLabel = new Map<string, GraphEdge[]>();
    for (const e of edges) {
      assertSafeLabel(e.label, 'edge');
      const bucket = byLabel.get(e.label) ?? [];
      bucket.push(e);
      byLabel.set(e.label, bucket);
    }
    const session = this.session();
    try {
      for (const [label, group] of byLabel) {
        // We MATCH endpoint nodes by id only (no label predicate) because
        // the GraphEdge contract carries from/to ids without label info.
        // The endpoint nodes must already exist (loader ordering: nodes
        // before edges); if they don't, the MERGE creates a relationship
        // to nothing and Cypher returns zero rows — so we use a strict
        // pattern that fails loudly via stats.relationshipsCreated check
        // at the call site if we ever need it.
        await session.executeWrite((tx) =>
          tx.run(
            `UNWIND $rows AS row
             MATCH (a {id: row.from})
             MATCH (b {id: row.to})
             MERGE (a)-[r:\`${label}\`]->(b)
             SET r += row.props,
                 r.sourceTypeId = row.sourceTypeId`,
            { rows: group.map(serializeEdge) },
          ),
        );
      }
    } finally {
      await session.close();
    }
  }

  async upsertVector(
    nodeId: string,
    vector: Float32Array,
    meta: Record<string, unknown>,
  ): Promise<void> {
    return this.upsertVectorsBulk([{ nodeId, vector, meta }]);
  }

  async upsertVectorsBulk(
    items: Array<{ nodeId: string; vector: Float32Array; meta: Record<string, unknown> }>,
  ): Promise<void> {
    if (items.length === 0) return;
    // Validate dim early — Neo4j's vector index will reject mismatches at
    // query time, but failing here gives a much clearer error.
    for (const it of items) {
      if (it.vector.length !== this.vectorDim) {
        throw new Error(
          `Neo4jBackend: vector dim mismatch for node ${it.nodeId} (got ${it.vector.length}, expected ${this.vectorDim})`,
        );
      }
    }
    const session = this.session();
    try {
      // Setting .embedding does NOT require knowing the node label — the
      // {id: …} predicate uniquely identifies the node across all labels.
      // Neo4j's vector index is keyed on (label, property), so the index
      // for whichever label the node has will pick up the new value
      // automatically.
      //
      // Property-type note: Neo4j only accepts scalars + scalar arrays as
      // property values. The meta object (`{ sourceTypeId, sourceId, … }`)
      // is JSON-stringified so it round-trips as a single STRING property
      // rather than a MAP (which Cypher rejects with 22N01).
      await session.executeWrite((tx) =>
        tx.run(
          `UNWIND $rows AS row
           MATCH (n {id: row.nodeId})
           SET n.embedding = row.vector,
               n.embeddingMeta = row.meta`,
          {
            rows: items.map((it) => ({
              nodeId: it.nodeId,
              // neo4j-driver doesn't accept Float32Array directly — convert.
              vector: Array.from(it.vector),
              meta: JSON.stringify(it.meta),
            })),
          },
        ),
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Cross-source-type linker: for a given OSS package name, find every
   * OssSection whose `text` contains an OssFunction or OssClass `name`
   * (within the same Version), and MERGE a `Documents` edge from the
   * section to the symbol.
   *
   * Best-effort heuristic — substring match, no symbol-resolution
   * intelligence. False positives possible (e.g., a section about
   * "the bar function" linking to a `bar` function in code), but
   * good enough for the v1 retrieval pattern "what docs explain this
   * symbol?". Phase D will add a smarter resolver (AST-aware references,
   * exact-token boundaries, etc.).
   *
   * Idempotent via MERGE on (section, symbol, label='Documents').
   * Re-runs after either side updates; old edges to deleted symbols
   * become orphaned and need a separate cleanup (also Phase D).
   *
   * Returns the number of new edges created (driver counters); the
   * count includes both freshly-inserted edges and refreshed
   * properties on existing ones — sufficient for "did the link pass
   * do useful work?" diagnostics.
   */
  async linkDocumentsToSymbols(packageName: string): Promise<number> {
    const session = this.session();
    try {
      // Walk: Package → Version → (OssDoc → OssSection)
      //                       ↓← (OssFile → OssFunction|OssClass)
      // Match section.text CONTAINS symbol.name → MERGE Documents edge.
      //
      // The CONTAINS predicate is O(text_len × name_len) per pair; for
      // a graph with ~10k symbols × ~10k sections, that's a tractable
      // one-shot post-ingest pass. If it becomes hot, swap to a Neo4j
      // full-text index on OssSection(text) + db.index.fulltext.queryNodes.
      //
      // Idempotent via MERGE on the (section, symbol, Documents) tuple.
      const result = await session.executeWrite((tx) =>
        tx.run(
          `MATCH (p:Package {name: $pkg})<-[:BelongsTo]-(v:Version)
           MATCH (doc:OssDoc)-[:BelongsTo]->(v)
           MATCH (doc)-[:Contains]->(sec:OssSection)
             WHERE sec.text IS NOT NULL AND sec.text <> ''
           MATCH (file:OssFile)-[:BelongsTo]->(v)
           MATCH (file)-[:Contains]->(sym)
             WHERE (sym:OssFunction OR sym:OssClass)
               AND sym.name IS NOT NULL AND sym.name <> ''
               AND sec.text CONTAINS sym.name
           MERGE (sec)-[r:Documents]->(sym)
             ON CREATE SET r.createdAt = datetime()
             ON MATCH  SET r.refreshedAt = datetime()
           RETURN count(r) AS edges`,
          { pkg: packageName },
        ),
      );
      const rec = result.records[0];
      return rec ? asJsNumber(rec.get('edges')) : 0;
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  private session(): Session {
    return this.driver.session({ database: this.database });
  }
}

function asJsNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber();
  }
  return Number(v);
}

// ─── helpers ────────────────────────────────────────────────────────────

function serializeNode(n: GraphNode): {
  id: string;
  props: Record<string, unknown>;
  sourceTypeId: string;
  sourceId: string;
  license: string | null;
} {
  return {
    id: n.id,
    props: jsonSafeMeta(n.properties),
    sourceTypeId: n.sourceTypeId,
    sourceId: n.sourceId,
    license: n.license ?? null,
  };
}

function serializeEdge(e: GraphEdge): {
  from: string;
  to: string;
  props: Record<string, unknown>;
  sourceTypeId: string;
} {
  return {
    from: e.from,
    to: e.to,
    props: jsonSafeMeta(e.properties ?? {}),
    sourceTypeId: e.sourceTypeId,
  };
}

/** Neo4j accepts only primitive scalars + their array variants as property
 *  values. Nested objects and undefined values must be flattened or stripped
 *  before they hit the driver. v1: drop non-primitive entries; future: JSON
 *  stringify if a use case appears. */
function jsonSafeMeta(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      out[k] = v;
    } else if (
      Array.isArray(v) &&
      v.every((x) => ['string', 'number', 'boolean'].includes(typeof x))
    ) {
      out[k] = v;
    }
    // else: silently dropped. Loader-emitted props are flat by convention.
  }
  return out;
}

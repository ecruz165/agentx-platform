/**
 * Vector-search query handler for /v1/context/query.
 *
 * Flow:
 *   1. Embed the query text via the same OpenAI-compat endpoint that
 *      ingest writes use, so query vectors live in the same vector space
 *      as stored vectors.
 *   2. Run Neo4j's `db.index.vector.queryNodes` against each label that
 *      has a vector index (registered at ingest time as
 *      `<Label>_vec_idx` per Neo4jBackend.ensureSchema).
 *   3. Return top-K matches across all label indexes, merged + re-sorted
 *      by score, with the node properties + score + source-tier metadata.
 *
 * v1 scoping rules:
 *   - Caller passes a `productId` for tenant scoping (decision #4) — we
 *     filter to nodes with `sourceId` matching that product when set.
 *   - Caller passes a `topK` (default 10).
 *   - Caller passes optional `labels` (default: every label that has an
 *     index in this database — discovered via SHOW INDEXES at startup).
 *   - We don't yet do graph-traversal expansion (Phase 2+). Pure vector
 *     ANN over the indexed labels.
 */

import { createHttpEmbedderClient } from '@ecruz165/context-loader-core';
import neo4j, { type Driver, type Session } from 'neo4j-driver';

export interface ContextQueryServiceOptions {
  /** Bolt URL (e.g., bolt://neo4j-edge:7687). */
  neo4jUrl: string;
  neo4jUser?: string;
  neo4jPassword: string;
  database?: string;
  /** OpenAI-compatible /v1 endpoint (the same one ingest used). */
  embedderUrl: string;
  embedderModel: string;
  embedderDim: number;
  /** Driver/connection config passthrough. */
  driverConfig?: Parameters<typeof neo4j.driver>[2];
}

export interface ContextQueryRequest {
  q: string;
  productId?: string;
  topK?: number;
  /** Restrict to specific node labels. Default: every indexed label. */
  labels?: string[];
  /** Graph expansion hops from each vector seed. 0 = pure vector ANN (the
   *  original v1 behavior — fully backward-compatible). Default
   *  QUERY_EXPAND_DEPTH_DEFAULT, clamped to [0, QUERY_EXPAND_DEPTH_MAX]. */
  expandDepth?: number;
  /** Restrict graph expansion to these relationship types (default: all). */
  expandPredicates?: string[];
  /** Reciprocal Rank Fusion weight for the vector (semantic) signal.
   *  Default QUERY_RRF_VECTOR_WEIGHT (1.0). */
  vectorWeight?: number;
  /** RRF weight for the BM25 (lexical) signal — exact identifiers, API
   *  names, error codes. 0 disables BM25. Default QUERY_RRF_BM25_WEIGHT (1.0). */
  bm25Weight?: number;
  /** RRF weight for the graph-expansion signal. A softer corroborating
   *  signal. 0 disables expansion fusion. Default QUERY_RRF_GRAPH_WEIGHT (0.5). */
  graphWeight?: number;
  /** Drop nodes whose total degree exceeds this from *expansion* (they can
   *  still surface via a direct vector/BM25 match). Off by default; set it for
   *  graphs where generic hubs (logging utils, index docs) pollute
   *  neighbors. */
  hubDegreeCeiling?: number;
  /** Per-relationship-type weights for graph expansion, e.g.
   *  `{ CALLS: 1, MENTIONS: 0.5 }`. Merged over DEFAULT_PREDICATE_WEIGHTS;
   *  unlisted types use QUERY_DEFAULT_PREDICATE_WEIGHT. A multi-hop path's
   *  weight is the product of its edge weights, so a path through a weak edge
   *  is weak overall. */
  expandPredicateWeights?: Record<string, number>;
  /** Soft-dampen graph pull by neighbor degree (`pull /= log2(degree + 2)`)
   *  so generic hubs contribute less without being excluded. Off by default —
   *  in code graphs, hubs (core services, base classes) are often the answer.
   *  Distinct from hubDegreeCeiling, which is a hard cutoff. */
  hubDampening?: boolean;
  /** Cap how many neighbors each seed contributes (keeps the strongest by
   *  edge weight). Bounds fan-out from a well-connected seed. Off by default. */
  maxNeighborsPerSeed?: number;
}

export interface ContextQueryHit {
  nodeId: string;
  label: string;
  /** Fused score — normalized vector + graph signals blended by vectorWeight. */
  score: number;
  /** Pruned set of node properties — small enough to return to a TUI. */
  properties: Record<string, unknown>;
  /** Provenance — which workspace / product / source-type produced it. */
  sourceTypeId?: string;
  sourceId?: string;
  /** Which signals surfaced this hit — a `+`-joined list of `vector`,
   *  `bm25`, `graph` (e.g. `vector+bm25`). A `graph`-only hit near the top
   *  means both vector and BM25 missed something structurally relevant. */
  via: string;
  /** Component signals retained for transparency + offline tuning. */
  vectorScore?: number;
  bm25Score?: number;
  graphScore?: number;
}

export interface ContextQueryResult {
  q: string;
  productId?: string;
  hits: ContextQueryHit[];
  /** Per-label diagnostics — useful when "no hits" surprises the caller. */
  searchedLabels: string[];
  topK: number;
  embeddingMs: number;
  searchMs: number;
}

/** Diagnostic snapshot of the backing graph. Surfaced via /v1/stats for
 *  monitoring + /health for liveness inspection. Counts are exact when
 *  cheap (small graphs, sub-second to compute) and may be approximate
 *  for very large stores in the future. */
export interface ContextStatsResult {
  /** Total node count across all labels. */
  nodeCount: number;
  /** Total edge count across all relationship types. */
  edgeCount: number;
  /** Labels that have a vector index attached — same set used by query
   *  when no `labels` filter is given. */
  indexedLabels: string[];
  /** ISO timestamp the stats were computed at. */
  ts: string;
}

/** Depth-bounded subgraph expansion from a seed node. Maps to PRD
 *  `graphrag.traverse` (§ 7.3). Caller passes the seed `entity` (matched
 *  by `n.id`), a hop count, and optionally a relationship-type allowlist
 *  + product scope. Returns the de-duplicated node + edge set with each
 *  node tagged by its minimum hop distance from the seed. */
export interface TraverseRequest {
  /** Node id (matches `n.id`). v1 does not match by name — callers can
   *  resolve a name to an id via /v1/context/query first. */
  entity: string;
  /** Hop count, clamped to [1, 5] server-side to bound query cost. */
  depth: number;
  /** Restrict to these relationship types (default: all). */
  predicates?: string[];
  /** sourceId STARTS WITH scoping — same convention as ContextQueryRequest. */
  productId?: string;
  /** Total node cap. Default 200, hard max 2000. */
  limit?: number;
}

export interface TraverseNode {
  nodeId: string;
  label: string;
  properties: Record<string, unknown>;
  /** Minimum hops from the seed. 0 for the seed itself. */
  distance: number;
}

export interface TraverseEdge {
  fromNodeId: string;
  toNodeId: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface TraverseResult {
  entity: string;
  depth: number;
  nodes: TraverseNode[];
  edges: TraverseEdge[];
  /** True when `limit` was hit; consumers know there's more graph beyond. */
  truncated: boolean;
}

/** Single-predicate adjacency lookup. Maps to `graphrag.related` (§ 7.3).
 *  Narrower than `traverse`: one relationship type, returns terminal
 *  nodes only (no path), ranked by minimum hop distance. */
export interface RelatedRequest {
  entity: string;
  /** Required — single relationship type. Use `traverse` for multi-predicate. */
  predicate: string;
  /** Hop count, clamped to [1, 5]. */
  depth: number;
  productId?: string;
  /** Default 50, hard max 500. */
  limit?: number;
}

export interface RelatedHit {
  nodeId: string;
  label: string;
  properties: Record<string, unknown>;
  distance: number;
}

export interface RelatedResult {
  entity: string;
  predicate: string;
  depth: number;
  hits: RelatedHit[];
  truncated: boolean;
}

/** Raw Cypher passthrough. Maps to `graphrag.cypher` (§ 7.3) — admin
 *  surface, gated to UDS-only per § 4.2 F31. v1 runs *every* request in
 *  Neo4j READ access mode for structural safety: no writes possible
 *  through this route, even with a malformed/malicious cypher string.
 *  Operators who genuinely need to write should use `cypher-shell`
 *  directly against Neo4j until v1.x adds an explicit write surface. */
export interface CypherRequest {
  cypher: string;
  /** Bind parameters — passed to Neo4j as named params, no string
   *  interpolation. */
  params?: Record<string, unknown>;
  /** Row cap. Default 100, hard max 1000. Truncation flagged in result. */
  limit?: number;
}

export interface CypherResult {
  /** Column names in the order they appeared in the RETURN clause. */
  columns: string[];
  /** One object per row, keyed by column name. Neo4j Node/Relationship
   *  values are normalized to plain objects (no driver class instances). */
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
}

/**
 * Structural interface for the query backend the server sits in front
 * of. Production wires `ContextQueryService` (real Neo4j); tests can
 * inject any implementation matching this shape, including pure
 * in-memory stubs that return canned results.
 *
 * Extracted so the server can stay decoupled from neo4j-driver — the
 * query module imports `neo4j-driver` heavily but a test stub doesn't
 * need to.
 */
export interface QueryService {
  query(req: ContextQueryRequest): Promise<ContextQueryResult>;
  stats(): Promise<ContextStatsResult>;
  traverse(req: TraverseRequest): Promise<TraverseResult>;
  related(req: RelatedRequest): Promise<RelatedResult>;
  cypher(req: CypherRequest): Promise<CypherResult>;
  close(): Promise<void>;
}

/** Server-side caps. Exposed for tests + CLI help text. */
export const TRAVERSE_DEPTH_MAX = 5;
export const TRAVERSE_LIMIT_DEFAULT = 200;
export const TRAVERSE_LIMIT_MAX = 2000;
export const RELATED_DEPTH_MAX = 5;
export const RELATED_LIMIT_DEFAULT = 50;
export const RELATED_LIMIT_MAX = 500;
export const CYPHER_LIMIT_DEFAULT = 100;
export const CYPHER_LIMIT_MAX = 1000;
/** Hybrid-fusion knobs for query(). Oversample vector seeds so graph
 *  expansion has room to promote a strong neighbor over a weak direct hit. */
export const QUERY_SEED_MULTIPLIER = 4;
export const QUERY_EXPAND_DEPTH_DEFAULT = 1;
export const QUERY_EXPAND_DEPTH_MAX = 2;
export const QUERY_EXPAND_LIMIT_MAX = 1000;
/** Reciprocal Rank Fusion constant — dampens low-ranked items' contribution.
 *  60 is the canonical value from the original RRF paper (Cormack et al.). */
export const QUERY_RRF_K = 60;
/** Default per-signal RRF weights. Vector + BM25 are co-primary; graph is a
 *  softer expansion signal that corroborates rather than dominates. */
export const QUERY_RRF_VECTOR_WEIGHT = 1.0;
export const QUERY_RRF_BM25_WEIGHT = 1.0;
export const QUERY_RRF_GRAPH_WEIGHT = 0.5;
/** Graph-score multiplier per hop. A 2-hop neighbor pulls half as hard as a
 *  1-hop neighbor, all else equal. */
export const QUERY_HOP_DECAY = 0.5;
/** Default per-relationship-type weights for graph expansion. Structural
 *  edges (CALLS/IMPORTS/EXTENDS/IMPLEMENTS) carry full weight; looser
 *  associative edges (MENTIONS/CONTAINS/REFERENCES) are dampened. Types not
 *  listed use QUERY_DEFAULT_PREDICATE_WEIGHT. */
export const DEFAULT_PREDICATE_WEIGHTS: Record<string, number> = {
  CALLS: 1.0,
  IMPORTS: 1.0,
  EXTENDS: 1.0,
  IMPLEMENTS: 1.0,
  REFERENCES: 0.8,
  CONTAINS: 0.7,
  MENTIONS: 0.5,
};
/** Weight for relationship types not in the (merged) weight map. */
export const QUERY_DEFAULT_PREDICATE_WEIGHT = 1.0;
/** Whitelist for relationship type names + Cypher identifier substitution.
 *  Anything failing this regex is rejected before reaching Cypher — defense
 *  in depth against injection through `predicate` / `predicates`. */
const SAFE_REL_TYPE = /^[A-Z_][A-Z0-9_]*$/i;

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Internal fusion candidate — a node that surfaced via vector match, graph
 *  expansion, or both, carrying whatever signals we have for it. */
export interface Candidate {
  nodeId: string;
  label: string;
  properties: Record<string, unknown>;
  sourceTypeId?: string;
  sourceId?: string;
  /** Present iff it was a direct vector (semantic) hit. */
  vectorScore?: number;
  /** Present iff it was a direct BM25 (lexical) hit. */
  bm25Score?: number;
  /** Present iff it was reached by graph expansion. */
  graphScore?: number;
}

export class ContextQueryService implements QueryService {
  private readonly driver: Driver;
  private readonly database: string;
  private readonly embedder: ReturnType<typeof createHttpEmbedderClient>;
  private readonly embedderModel: string;
  /** Labels with a `<Label>_vec_idx` vector index — discovered lazily on
   *  first query and cached. Re-discovery happens on schema mismatch. */
  private indexedLabels: string[] | null = null;
  /** label → full-text index name, discovered lazily and cached. Empty when
   *  no FULLTEXT indexes exist yet (BM25 then silently no-ops). */
  private fulltextIndexes: Map<string, string> | null = null;

  constructor(opts: ContextQueryServiceOptions) {
    this.driver = neo4j.driver(
      opts.neo4jUrl,
      neo4j.auth.basic(opts.neo4jUser ?? 'neo4j', opts.neo4jPassword),
      opts.driverConfig,
    );
    this.database = opts.database ?? 'neo4j';
    this.embedder = createHttpEmbedderClient({
      config: { url: opts.embedderUrl, model: opts.embedderModel, dim: opts.embedderDim },
    });
    this.embedderModel = opts.embedderModel;
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  /**
   * Cheap graph stats for /v1/stats + /health. Runs three small
   * Cypher queries in a single session — node count, edge count,
   * indexed-label list. Trivial overhead on small graphs; for
   * mega-graphs (10M+ nodes), Neo4j's `count()` is approximate
   * via Estimated Statistics — not bothered with that here.
   */
  async stats(): Promise<ContextStatsResult> {
    const session = this.session();
    try {
      const nodeRes = await session.run(`MATCH (n) RETURN count(n) AS c`);
      const edgeRes = await session.run(`MATCH ()-[r]->() RETURN count(r) AS c`);
      const indexedLabels = await this.discoverIndexedLabels();
      return {
        nodeCount: asNumber(nodeRes.records[0]?.get('c') ?? 0),
        edgeCount: asNumber(edgeRes.records[0]?.get('c') ?? 0),
        indexedLabels,
        ts: new Date().toISOString(),
      };
    } finally {
      await session.close();
    }
  }

  async query(req: ContextQueryRequest): Promise<ContextQueryResult> {
    const topK = req.topK ?? 10;
    const expandDepth = clamp(req.expandDepth ?? QUERY_EXPAND_DEPTH_DEFAULT, 0, QUERY_EXPAND_DEPTH_MAX);
    const weights: RrfWeights = {
      vector: clampNonNeg(req.vectorWeight ?? QUERY_RRF_VECTOR_WEIGHT),
      bm25: clampNonNeg(req.bm25Weight ?? QUERY_RRF_BM25_WEIGHT),
      graph: clampNonNeg(req.graphWeight ?? QUERY_RRF_GRAPH_WEIGHT),
    };

    // 1. Embed the query text in the same vector space as stored vectors.
    const embedStart = Date.now();
    const [queryVec] = await this.embedder.embed([req.q]);
    if (!queryVec) {
      throw new Error('embedder returned no vector for query');
    }
    const embeddingMs = Date.now() - embedStart;

    const searchStart = Date.now();
    const labels = req.labels ?? (await this.discoverIndexedLabels());
    const seedK = expandDepth > 0 ? topK * QUERY_SEED_MULTIPLIER : topK;

    // 2. Seed from two independent signals in parallel: vector ANN
    //    (semantics) + BM25 full-text (lexical/exact terms). BM25 is skipped
    //    when its weight is 0 or no full-text index exists.
    const [vSeeds, bSeeds] = await Promise.all([
      this.vectorSeeds(Array.from(queryVec), labels, seedK, req.productId),
      weights.bm25 > 0 ? this.bm25Seeds(req.q, labels, seedK, req.productId) : Promise.resolve([]),
    ]);

    // Merge seeds — keyed by nodeId so a node hit by both signals carries
    // both component scores.
    const candidates = new Map<string, Candidate>();
    for (const s of vSeeds) candidates.set(s.nodeId, s);
    for (const s of bSeeds) {
      const existing = candidates.get(s.nodeId);
      if (existing) existing.bm25Score = s.bm25Score;
      else candidates.set(s.nodeId, s);
    }

    // 3. Deterministic graph expansion around the union of seeds (no LLM in
    //    the path). Seed pull is normalized per-signal so vector and BM25
    //    seeds anchor expansion on a comparable scale.
    if (expandDepth > 0 && weights.graph > 0 && candidates.size > 0) {
      const seedScores = normalizedSeedScores([...candidates.values()]);
      const neighbors = await this.expandGraph([...seedScores.keys()], seedScores, expandDepth, {
        predicates: req.expandPredicates,
        productId: req.productId,
        hubDegreeCeiling: req.hubDegreeCeiling,
        predicateWeights: req.expandPredicateWeights,
        hubDampening: req.hubDampening,
        maxNeighborsPerSeed: req.maxNeighborsPerSeed,
      });
      for (const n of neighbors) {
        const existing = candidates.get(n.nodeId);
        if (existing) existing.graphScore = n.graphScore;
        else candidates.set(n.nodeId, n);
      }
    }

    // 4. Reciprocal Rank Fusion across all three signals, rank, slice to topK.
    const hits = rrfFuse([...candidates.values()], weights, topK);
    const searchMs = Date.now() - searchStart;

    return {
      q: req.q,
      productId: req.productId,
      hits,
      searchedLabels: labels,
      topK,
      embeddingMs,
      searchMs,
    };
  }

  /** Per-label BM25 full-text seeds. Mirrors vectorSeeds but over Lucene
   *  full-text indexes (`<Label>_fts_idx`). No-ops (returns []) when no
   *  full-text index exists yet, so the path degrades to vector + graph. */
  private async bm25Seeds(
    queryText: string,
    labels: string[],
    k: number,
    productId?: string,
  ): Promise<Candidate[]> {
    const indexes = await this.discoverFulltextIndexes();
    if (indexes.size === 0) return [];
    const lucene = escapeLucene(queryText);
    if (!lucene) return [];

    const session = this.session();
    const out: Candidate[] = [];
    try {
      for (const label of labels) {
        const indexName = indexes.get(label);
        if (!indexName) continue; // no full-text index for this label
        const productPredicate = productId ? ` WHERE n.sourceId STARTS WITH $productPrefix` : '';
        const params: Record<string, unknown> = { indexName, q: lucene, k: neo4j.int(k) };
        if (productId) params.productPrefix = productId;

        const cypher = `CALL db.index.fulltext.queryNodes($indexName, $q)
           YIELD node AS n, score
           ${productPredicate}
           RETURN n.id AS id, score, properties(n) AS props,
                  n.sourceTypeId AS sourceTypeId, n.sourceId AS sourceId
           LIMIT $k`;
        try {
          const r = await session.run(cypher, params);
          for (const rec of r.records) {
            out.push({
              nodeId: String(rec.get('id') ?? ''),
              label,
              properties: stripVectorProps(rec.get('props') as Record<string, unknown>),
              bm25Score: asNumber(rec.get('score')),
              sourceTypeId: rec.get('sourceTypeId') as string | undefined,
              sourceId: rec.get('sourceId') as string | undefined,
            });
          }
        } catch (err) {
          // Index vanished or query failed — drop the cache and skip.
          if (this.fulltextIndexes && (err as Error).message.includes('no such')) {
            this.fulltextIndexes = null;
          }
        }
      }
    } finally {
      await session.close();
    }
    return out;
  }

  /** Per-label vector ANN — the original query() core, extracted. Returns
   *  candidates tagged `via: 'vector'` with `vectorScore` set; fusion +
   *  ranking happen in the caller. */
  private async vectorSeeds(
    queryVec: number[],
    labels: string[],
    k: number,
    productId?: string,
  ): Promise<Candidate[]> {
    const session = this.session();
    const out: Candidate[] = [];
    try {
      for (const label of labels) {
        if (!SAFE_IDENT.test(label)) continue; // defense-in-depth
        // Optional product-scope filter — only nodes whose sourceId starts
        // with the product id, matching the loader's tagging convention.
        const productPredicate = productId ? ` WHERE n.sourceId STARTS WITH $productPrefix` : '';
        const params: Record<string, unknown> = {
          indexName: `${label}_vec_idx`,
          k: neo4j.int(k),
          vec: queryVec,
        };
        if (productId) params.productPrefix = productId;

        const cypher = `CALL db.index.vector.queryNodes($indexName, $k, $vec)
           YIELD node AS n, score
           ${productPredicate}
           RETURN n.id AS id, score, properties(n) AS props,
                  n.sourceTypeId AS sourceTypeId, n.sourceId AS sourceId`;
        try {
          const r = await session.run(cypher, params);
          for (const rec of r.records) {
            out.push({
              nodeId: String(rec.get('id') ?? ''),
              label,
              properties: stripVectorProps(rec.get('props') as Record<string, unknown>),
              vectorScore: asNumber(rec.get('score')),
              sourceTypeId: rec.get('sourceTypeId') as string | undefined,
              sourceId: rec.get('sourceId') as string | undefined,
            });
          }
        } catch (err) {
          // Index missing for this label, or query failed — skip and keep
          // going. Common case: a freshly-created label whose index hasn't
          // populated, or a stale cached label list.
          if (this.indexedLabels && (err as Error).message.includes('no such index')) {
            this.indexedLabels = null; // force re-discovery next time
          }
        }
      }
    } finally {
      await session.close();
    }
    return out;
  }

  /** One Cypher round-trip: expand 1..depth hops from ALL seeds at once.
   *  Each path's structural weight is the product of its edge weights
   *  (per-relationship-type), so weak edge types (e.g. MENTIONS) and paths
   *  through them contribute less. Per (seed, neighbor) we keep the single
   *  strongest reach; optionally cap neighbors per seed. The MAX-based,
   *  optionally degree-dampened graph score is computed in graphScoreFor.
   *  READ-mode session: structurally cannot mutate the graph. */
  private async expandGraph(
    seedIds: string[],
    seedScores: Map<string, number>,
    depth: number,
    opts: {
      predicates?: string[];
      productId?: string;
      hubDegreeCeiling?: number;
      predicateWeights?: Record<string, number>;
      hubDampening?: boolean;
      maxNeighborsPerSeed?: number;
    } = {},
  ): Promise<Candidate[]> {
    const relFilter = buildRelFilter(opts.predicates);
    const productScope = opts.productId ? ` AND nbr.sourceId STARTS WITH $productPrefix` : '';
    // Exclude over-connected nodes from expansion (still reachable by vector).
    const hubScope = opts.hubDegreeCeiling != null ? ` AND COUNT { (nbr)--() } <= $hubCeiling` : '';
    // Merge caller weights over defaults; only finite, non-negative numbers.
    const weights: Record<string, number> = { ...DEFAULT_PREDICATE_WEIGHTS };
    for (const [k, v] of Object.entries(opts.predicateWeights ?? {})) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) weights[k] = v;
    }
    // Optional per-seed neighbor cap: keep each seed's strongest reaches.
    const capClause =
      opts.maxNeighborsPerSeed != null
        ? `ORDER BY best.weight DESC, best.len ASC
           WITH seedId, collect({nbr: nbr, best: best})[0..$maxPerSeed] AS top
           UNWIND top AS t
           WITH t.nbr AS nbr, seedId, t.best AS best`
        : '';

    const session = this.readSession();
    try {
      const cypher = `
        MATCH (seed) WHERE seed.id IN $seedIds
        MATCH path = (seed)-[${relFilter}*1..${depth}]-(nbr)
        WHERE nbr.id <> seed.id${productScope}${hubScope}
        WITH seed.id AS seedId, nbr,
             length(path) AS len,
             reduce(w = 1.0, r IN relationships(path) |
               w * coalesce($relWeights[type(r)], $defaultRelWeight)) AS pathWeight
        ORDER BY pathWeight DESC, len ASC
        WITH seedId, nbr, head(collect({len: len, weight: pathWeight})) AS best
        ${capClause}
        WITH nbr,
             collect({seedId: seedId, dist: best.len, weight: best.weight}) AS reaches,
             COUNT { (nbr)--() } AS degree
        RETURN nbr.id AS id, labels(nbr) AS labels, properties(nbr) AS props,
               nbr.sourceTypeId AS sourceTypeId, nbr.sourceId AS sourceId,
               reaches, degree
        LIMIT $expandLimit
      `;
      const params: Record<string, unknown> = {
        seedIds,
        expandLimit: neo4j.int(QUERY_EXPAND_LIMIT_MAX),
        relWeights: weights,
        defaultRelWeight: QUERY_DEFAULT_PREDICATE_WEIGHT,
      };
      if (opts.productId) params.productPrefix = opts.productId;
      if (opts.hubDegreeCeiling != null) params.hubCeiling = neo4j.int(opts.hubDegreeCeiling);
      if (opts.maxNeighborsPerSeed != null) params.maxPerSeed = neo4j.int(opts.maxNeighborsPerSeed);

      const r = await session.run(cypher, params);
      return r.records.map((rec) => {
        const reaches = rec.get('reaches') as Array<{
          seedId: string;
          dist: unknown;
          weight: unknown;
        }>;
        return {
          nodeId: String(rec.get('id') ?? ''),
          label: firstLabel(rec.get('labels')),
          properties: stripVectorProps(rec.get('props') as Record<string, unknown>),
          sourceTypeId: rec.get('sourceTypeId') as string | undefined,
          sourceId: rec.get('sourceId') as string | undefined,
          graphScore: graphScoreFor(reaches, seedScores, {
            degree: asNumber(rec.get('degree')),
            dampen: opts.hubDampening,
          }),
        };
      });
    } finally {
      await session.close();
    }
  }

  async traverse(req: TraverseRequest): Promise<TraverseResult> {
    const depth = clamp(req.depth, 1, TRAVERSE_DEPTH_MAX);
    const limit = clamp(req.limit ?? TRAVERSE_LIMIT_DEFAULT, 1, TRAVERSE_LIMIT_MAX);
    const relFilter = buildRelFilter(req.predicates);

    // Two-step: (1) gather distinct nodes within `depth` hops with min
    // distance, (2) gather edges among that node set. Splitting this
    // way is faster + simpler than collecting whole paths and lets the
    // limit apply cleanly to nodes (which is what consumers care about).
    const session = this.readSession();
    try {
      const productScope = req.productId ? ` AND end.sourceId STARTS WITH $productPrefix` : '';
      const nodeCypher = `
        MATCH (start {id: $entity})
        WITH start
        MATCH path = (start)-[${relFilter}*1..${depth}]-(end)
        WHERE end <> start${productScope}
        WITH start, end, min(length(path)) AS distance
        RETURN
          end.id AS id,
          labels(end) AS labels,
          properties(end) AS props,
          distance,
          start.id AS startId,
          labels(start) AS startLabels,
          properties(start) AS startProps
        ORDER BY distance ASC, end.id ASC
        LIMIT $limit
      `;
      const params: Record<string, unknown> = {
        entity: req.entity,
        limit: neo4j.int(limit + 1), // +1 to detect truncation
      };
      if (req.productId) params.productPrefix = req.productId;

      const r = await session.run(nodeCypher, params);
      const truncated = r.records.length > limit;
      const records = truncated ? r.records.slice(0, limit) : r.records;

      const nodes: TraverseNode[] = [];
      let seedAdded = false;
      for (const rec of records) {
        if (!seedAdded) {
          const seedProps = stripVectorProps(rec.get('startProps') as Record<string, unknown>);
          nodes.push({
            nodeId: String(rec.get('startId') ?? req.entity),
            label: firstLabel(rec.get('startLabels')),
            properties: seedProps,
            distance: 0,
          });
          seedAdded = true;
        }
        const props = stripVectorProps(rec.get('props') as Record<string, unknown>);
        nodes.push({
          nodeId: String(rec.get('id') ?? ''),
          label: firstLabel(rec.get('labels')),
          properties: props,
          distance: asNumber(rec.get('distance')),
        });
      }

      // Seed-only result (no neighbors) — still surface the seed node
      // so callers can confirm it exists. Omitting it would look like
      // "entity not found" which is misleading.
      if (!seedAdded) {
        const seed = await session.run(
          `MATCH (n {id: $entity}) RETURN n.id AS id, labels(n) AS labels, properties(n) AS props LIMIT 1`,
          { entity: req.entity },
        );
        if (seed.records[0]) {
          const props = stripVectorProps(seed.records[0].get('props') as Record<string, unknown>);
          nodes.push({
            nodeId: String(seed.records[0].get('id') ?? req.entity),
            label: firstLabel(seed.records[0].get('labels')),
            properties: props,
            distance: 0,
          });
        }
      }

      // Edges among the collected node set. Cap by relationship limit
      // proportional to nodes (^2 worst-case, but typically sparse).
      const ids = nodes.map((n) => n.nodeId);
      let edges: TraverseEdge[] = [];
      if (ids.length > 1) {
        const edgeRes = await session.run(
          `MATCH (a)-[r]->(b)
             WHERE a.id IN $ids AND b.id IN $ids
             RETURN a.id AS from, b.id AS to, type(r) AS type, properties(r) AS props
             LIMIT $edgeLimit`,
          { ids, edgeLimit: neo4j.int(limit * 4) },
        );
        edges = edgeRes.records.map((rec) => ({
          fromNodeId: String(rec.get('from') ?? ''),
          toNodeId: String(rec.get('to') ?? ''),
          type: String(rec.get('type') ?? ''),
          properties: (rec.get('props') as Record<string, unknown>) ?? {},
        }));
      }

      return { entity: req.entity, depth, nodes, edges, truncated };
    } finally {
      await session.close();
    }
  }

  async related(req: RelatedRequest): Promise<RelatedResult> {
    if (!SAFE_REL_TYPE.test(req.predicate)) {
      throw new Error(`invalid predicate: must match ${SAFE_REL_TYPE.source}`);
    }
    const depth = clamp(req.depth, 1, RELATED_DEPTH_MAX);
    const limit = clamp(req.limit ?? RELATED_LIMIT_DEFAULT, 1, RELATED_LIMIT_MAX);
    const session = this.readSession();
    try {
      const productScope = req.productId ? ` AND end.sourceId STARTS WITH $productPrefix` : '';
      const cypher = `
        MATCH (start {id: $entity})
        MATCH path = (start)-[:\`${req.predicate}\`*1..${depth}]-(end)
        WHERE end <> start${productScope}
        WITH end, min(length(path)) AS distance
        RETURN end.id AS id, labels(end) AS labels, properties(end) AS props, distance
        ORDER BY distance ASC, end.id ASC
        LIMIT $limit
      `;
      const params: Record<string, unknown> = {
        entity: req.entity,
        limit: neo4j.int(limit + 1),
      };
      if (req.productId) params.productPrefix = req.productId;

      const r = await session.run(cypher, params);
      const truncated = r.records.length > limit;
      const records = truncated ? r.records.slice(0, limit) : r.records;
      const hits = records.map((rec) => ({
        nodeId: String(rec.get('id') ?? ''),
        label: firstLabel(rec.get('labels')),
        properties: stripVectorProps(rec.get('props') as Record<string, unknown>),
        distance: asNumber(rec.get('distance')),
      }));
      return {
        entity: req.entity,
        predicate: req.predicate,
        depth,
        hits,
        truncated,
      };
    } finally {
      await session.close();
    }
  }

  async cypher(req: CypherRequest): Promise<CypherResult> {
    const limit = clamp(req.limit ?? CYPHER_LIMIT_DEFAULT, 1, CYPHER_LIMIT_MAX);
    // READ access mode: any clause that mutates the graph (CREATE, MERGE,
    // SET, DELETE, REMOVE) raises Neo.ClientError.Statement.AccessMode
    // before the query runs. v1 admin Cypher is read-only, period.
    const session = this.readSession();
    try {
      const params = sanitizeParams(req.params);
      const r = await session.run(req.cypher, params);
      const columns = r.records[0] ? r.records[0].keys.map(String) : [];
      const truncated = r.records.length > limit;
      const records = truncated ? r.records.slice(0, limit) : r.records;
      const rows = records.map((rec) => {
        const row: Record<string, unknown> = {};
        for (const k of rec.keys) {
          row[String(k)] = normalizeCypherValue(rec.get(k));
        }
        return row;
      });
      return { columns, rows, rowCount: rows.length, truncated };
    } finally {
      await session.close();
    }
  }

  /** Lists labels that have a `<Label>_vec_idx` vector index in the
   *  database. Returns the bare label, not the index name. */
  private async discoverIndexedLabels(): Promise<string[]> {
    if (this.indexedLabels) return this.indexedLabels;
    const session = this.session();
    try {
      const r = await session.run(
        `SHOW INDEXES YIELD name, type, labelsOrTypes
         WHERE type = 'VECTOR'
         RETURN name, labelsOrTypes`,
      );
      const labels: string[] = [];
      for (const rec of r.records) {
        const list = rec.get('labelsOrTypes') as string[] | null;
        if (list) labels.push(...list);
      }
      // Deduplicate (a label can have multiple vector indexes in theory).
      this.indexedLabels = [...new Set(labels)];
      return this.indexedLabels;
    } finally {
      await session.close();
    }
  }

  /** Maps each label to its FULLTEXT index name. Empty when none exist yet
   *  (BM25 then no-ops). Cached; re-discovered if a query hits a stale name. */
  private async discoverFulltextIndexes(): Promise<Map<string, string>> {
    if (this.fulltextIndexes) return this.fulltextIndexes;
    const session = this.session();
    try {
      const r = await session.run(
        `SHOW INDEXES YIELD name, type, labelsOrTypes
         WHERE type = 'FULLTEXT'
         RETURN name, labelsOrTypes`,
      );
      const m = new Map<string, string>();
      for (const rec of r.records) {
        const name = String(rec.get('name'));
        const list = rec.get('labelsOrTypes') as string[] | null;
        if (list) for (const lbl of list) m.set(lbl, name);
      }
      this.fulltextIndexes = m;
      return m;
    } finally {
      await session.close();
    }
  }

  private session(): Session {
    return this.driver.session({ database: this.database });
  }

  /** READ-mode session for traverse / related / cypher. Forces
   *  Neo4j-side write rejection independent of the cypher string. */
  private readSession(): Session {
    return this.driver.session({
      database: this.database,
      defaultAccessMode: neo4j.session.READ,
    });
  }
}

function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber();
  }
  return Number(v);
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

/** Non-negative clamp for RRF weights. NaN/negative → 0 (disables signal). */
function clampNonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Escape Lucene query-syntax metacharacters so free-text queries can't
 *  throw a parse error or inject operators into the full-text search. */
function escapeLucene(s: string): string {
  return s.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&').trim();
}

export interface RrfWeights {
  vector: number;
  bm25: number;
  graph: number;
}

/** Per-signal seed pull, normalized to [0, 1] within each signal so vector
 *  (cosine) and BM25 (Lucene) seeds anchor graph expansion on a comparable
 *  scale. A node that's a seed in both takes the stronger of the two. */
function normalizedSeedScores(seeds: Candidate[]): Map<string, number> {
  const maxV = seeds.reduce((m, c) => Math.max(m, c.vectorScore ?? 0), 1e-9);
  const maxB = seeds.reduce((m, c) => Math.max(m, c.bm25Score ?? 0), 1e-9);
  const out = new Map<string, number>();
  for (const c of seeds) {
    const pull = Math.max((c.vectorScore ?? 0) / maxV, (c.bm25Score ?? 0) / maxB);
    if (pull > 0) out.set(c.nodeId, pull);
  }
  return out;
}

/** `+`-joined list of the signals that surfaced a candidate. */
function viaOf(c: Candidate): string {
  const parts: string[] = [];
  if (c.vectorScore != null) parts.push('vector');
  if (c.bm25Score != null) parts.push('bm25');
  if (c.graphScore != null) parts.push('graph');
  return parts.join('+') || 'none';
}

/** Graph pull on a neighbor = its single strongest seed link, scaled by the
 *  reach's relationship weight and decayed by hop distance. MAX (not sum) by
 *  design: in hub-dense graphs, summing pull across every seed a node touches
 *  inflates well-connected nodes on connectivity alone. Optionally soft-dampen
 *  by neighbor degree (IDF-style) so generic hubs contribute less. */
export function graphScoreFor(
  reaches: Array<{ seedId: string; dist: unknown; weight?: unknown }>,
  seedScores: Map<string, number>,
  opts: { degree?: number; dampen?: boolean } = {},
): number {
  let best = 0;
  for (const { seedId, dist, weight } of reaches) {
    const d = asNumber(dist); // 1-based hop count
    const w = weight == null ? 1 : asNumber(weight); // relationship weight
    const pull = (seedScores.get(seedId) ?? 0) * w * QUERY_HOP_DECAY ** (d - 1);
    if (pull > best) best = pull;
  }
  if (opts.dampen && opts.degree != null && opts.degree > 0) {
    best /= Math.log2(opts.degree + 2);
  }
  return best;
}

/**
 * Reciprocal Rank Fusion across the three signals. RRF fuses by *rank*, not
 * raw score, so it sidesteps the scale mismatch between cosine (0–1), Lucene
 * BM25 (unbounded), and graph pull — the reason a weighted sum of raw scores
 * would be dominated by whichever signal has the largest numbers.
 *
 * For each signal a candidate appears in at rank r, it earns
 * `weight / (K + r)`; contributions sum across signals, so a node ranked
 * highly by multiple signals beats one that's #1 in a single signal. The
 * final score is normalized to [0, 1] for readable output — order-preserving.
 */
export function rrfFuse(
  candidates: Candidate[],
  weights: RrfWeights,
  topK: number,
): ContextQueryHit[] {
  // 1-based rank of each candidate within each signal's sorted list.
  const rankBy = (key: 'vectorScore' | 'bm25Score' | 'graphScore'): Map<string, number> => {
    const ranked = candidates
      .filter((c) => c[key] != null)
      .sort((a, b) => (b[key] as number) - (a[key] as number));
    const m = new Map<string, number>();
    ranked.forEach((c, i) => m.set(c.nodeId, i + 1));
    return m;
  };
  const vRank = rankBy('vectorScore');
  const bRank = rankBy('bm25Score');
  const gRank = rankBy('graphScore');

  const scored = candidates.map((c) => {
    let rrf = 0;
    const v = vRank.get(c.nodeId);
    if (v != null) rrf += weights.vector / (QUERY_RRF_K + v);
    const b = bRank.get(c.nodeId);
    if (b != null) rrf += weights.bm25 / (QUERY_RRF_K + b);
    const g = gRank.get(c.nodeId);
    if (g != null) rrf += weights.graph / (QUERY_RRF_K + g);
    return { c, rrf };
  });
  const maxRrf = scored.reduce((m, s) => Math.max(m, s.rrf), 1e-9);
  scored.sort((a, b) => b.rrf - a.rrf);

  return scored.slice(0, topK).map(({ c, rrf }) => ({
    nodeId: c.nodeId,
    label: c.label,
    score: rrf / maxRrf, // normalize to [0, 1] for presentation; order preserved
    properties: c.properties,
    sourceTypeId: c.sourceTypeId,
    sourceId: c.sourceId,
    via: viaOf(c),
    vectorScore: c.vectorScore,
    bm25Score: c.bm25Score,
    graphScore: c.graphScore,
  }));
}

function firstLabel(v: unknown): string {
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return v[0];
  return '';
}

function stripVectorProps(props: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!props) return {};
  const copy = { ...props };
  delete copy.embedding;
  delete copy.embeddingMeta;
  return copy;
}

/** Build the `[:TYPE_A|TYPE_B]` portion of a variable-length match.
 *  Empty result means "any type". Filters out names that don't match the
 *  safe-identifier regex — defense in depth against caller-supplied
 *  predicate lists making it into Cypher unescaped. */
function buildRelFilter(predicates: string[] | undefined): string {
  if (!predicates || predicates.length === 0) return '';
  const safe = predicates.filter((p) => SAFE_REL_TYPE.test(p));
  if (safe.length === 0) return '';
  return `:${safe.map((p) => `\`${p}\``).join('|')}`;
}

/** Run before passing user-supplied bind params into Neo4j. Removes
 *  prototype pollution (`__proto__` etc.) and rejects functions. */
function sanitizeParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!params || typeof params !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (typeof v === 'function') continue;
    out[k] = v;
  }
  return out;
}

/** Convert neo4j-driver record values into plain JSON-safe shapes.
 *  Nodes / Relationships / Paths get unwrapped; Integer becomes number;
 *  primitives pass through. */
function normalizeCypherValue(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v !== 'object') return v;

  // neo4j Integer
  if (typeof (v as { toNumber?: unknown }).toNumber === 'function' && 'low' in (v as object) && 'high' in (v as object)) {
    return (v as { toNumber(): number }).toNumber();
  }
  // Node — has identity + labels + properties
  const obj = v as Record<string, unknown>;
  if ('labels' in obj && 'properties' in obj && 'identity' in obj) {
    return {
      _kind: 'node',
      labels: obj.labels,
      properties: stripVectorProps(obj.properties as Record<string, unknown>),
    };
  }
  // Relationship — has type + start + end + properties
  if ('type' in obj && 'start' in obj && 'end' in obj && 'properties' in obj) {
    return {
      _kind: 'relationship',
      type: obj.type,
      properties: obj.properties,
    };
  }
  // Path — has segments
  if ('segments' in obj && Array.isArray(obj.segments)) {
    return { _kind: 'path', length: (obj.segments as unknown[]).length };
  }
  // Array
  if (Array.isArray(v)) return v.map(normalizeCypherValue);
  // Plain object — recurse
  const copy: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj)) copy[k] = normalizeCypherValue(val);
  return copy;
}

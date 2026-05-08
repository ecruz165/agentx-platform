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
}

export interface ContextQueryHit {
  nodeId: string;
  label: string;
  score: number;
  /** Pruned set of node properties — small enough to return to a TUI. */
  properties: Record<string, unknown>;
  /** Provenance — which workspace / product / source-type produced it. */
  sourceTypeId?: string;
  sourceId?: string;
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
/** Whitelist for relationship type names + Cypher identifier substitution.
 *  Anything failing this regex is rejected before reaching Cypher — defense
 *  in depth against injection through `predicate` / `predicates`. */
const SAFE_REL_TYPE = /^[A-Z_][A-Z0-9_]*$/i;

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class ContextQueryService implements QueryService {
  private readonly driver: Driver;
  private readonly database: string;
  private readonly embedder: ReturnType<typeof createHttpEmbedderClient>;
  private readonly embedderModel: string;
  /** Labels with a `<Label>_vec_idx` vector index — discovered lazily on
   *  first query and cached. Re-discovery happens on schema mismatch. */
  private indexedLabels: string[] | null = null;

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

    // 1. Embed the query text in the same vector space as stored vectors.
    const embedStart = Date.now();
    const [queryVec] = await this.embedder.embed([req.q]);
    if (!queryVec) {
      throw new Error('embedder returned no vector for query');
    }
    const embeddingMs = Date.now() - embedStart;

    // 2. Discover indexed labels if we don't already know them.
    const labels = req.labels ?? (await this.discoverIndexedLabels());

    // 3. Vector search per label, merge, re-sort.
    const searchStart = Date.now();
    const session = this.session();
    const allHits: ContextQueryHit[] = [];
    try {
      for (const label of labels) {
        if (!SAFE_IDENT.test(label)) continue; // defense-in-depth
        const indexName = `${label}_vec_idx`;
        const params: Record<string, unknown> = {
          indexName,
          k: neo4j.int(topK),
          vec: Array.from(queryVec),
        };
        // Optional product-scope filter — only nodes whose sourceId starts
        // with the product id. This matches the loader's convention of
        // tagging sourceId with the product (Phase G.5 setup).
        const productPredicate = req.productId
          ? ` WHERE n.sourceId STARTS WITH $productPrefix`
          : '';
        if (req.productId) params.productPrefix = req.productId;

        const cypher = `CALL db.index.vector.queryNodes($indexName, $k, $vec)
           YIELD node AS n, score
           ${productPredicate}
           RETURN n.id AS id, labels(n) AS labels, score,
                  properties(n) AS props,
                  n.sourceTypeId AS sourceTypeId,
                  n.sourceId AS sourceId`;
        try {
          const r = await session.run(cypher, params);
          for (const rec of r.records) {
            const props = rec.get('props') as Record<string, unknown>;
            // Strip the embedding from returned properties — it's huge,
            // useless to consumers, and would dwarf the actual content.
            delete props.embedding;
            delete props.embeddingMeta;
            allHits.push({
              nodeId: String(rec.get('id') ?? ''),
              label,
              score: asNumber(rec.get('score')),
              properties: props,
              sourceTypeId: rec.get('sourceTypeId') as string | undefined,
              sourceId: rec.get('sourceId') as string | undefined,
            });
          }
        } catch (err) {
          // Index doesn't exist for this label, or query failed — skip
          // and keep going. Common case: a label was just created and its
          // index hasn't populated yet, or the cached label list is stale.
          if (this.indexedLabels && (err as Error).message.includes('no such index')) {
            this.indexedLabels = null; // force re-discovery next time
          }
        }
      }
    } finally {
      await session.close();
    }
    const searchMs = Date.now() - searchStart;

    // Top-K across all labels, sorted by score descending.
    allHits.sort((a, b) => b.score - a.score);
    const hits = allHits.slice(0, topK);

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

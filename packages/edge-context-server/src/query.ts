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
  close(): Promise<void>;
}

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
}

function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber();
  }
  return Number(v);
}

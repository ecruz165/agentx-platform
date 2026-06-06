/**
 * Real-Neo4j integration tests for ContextQueryService.
 *
 * Gated behind RUN_NEO4J_INTEGRATION=1 because they require a live
 * neo4j-edge plus a running Docker Model Runner (the embedder serves at
 * http://localhost:12434/engines/llama.cpp/v1).
 *
 * Local run:
 *   docker compose up -d neo4j-edge embedder
 *   RUN_NEO4J_INTEGRATION=1 \
 *     NEO4J_TEST_PASSWORD=devpassword \
 *     pnpm --filter @ecruz165/edge-context-server test
 *
 * The test seeds a fresh label namespace (`Symbol_<runId>`) with a few
 * synthetic Function-shaped nodes, embeds known terms, runs vector
 * search, and asserts the most-similar node ranks first. Avoids
 * depending on the harness-core ingest having been run.
 */

import { Neo4jBackend } from '@ecruz165/context-loader-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMode,
  type Candidate,
  ContextQueryService,
  graphScoreFor,
  QUERY_HOP_DECAY,
  RETRIEVAL_MODES,
  type RrfWeights,
  rrfFuse,
} from './query.ts';

const EQUAL: RrfWeights = { vector: 1, bm25: 1, graph: 1 };

describe('applyMode — deterministic mode → retrieval preset', () => {
  it('applies a known preset (impact → depth 2)', () => {
    const r = applyMode({ q: 'x', mode: 'impact' });
    expect(r.expandDepth).toBe(RETRIEVAL_MODES.impact!.expandDepth);
    expect(r.expandPredicates).toEqual(['CALLS', 'IMPORTS']);
    expect(r.topK).toBe(20);
  });

  it('explicit request fields override the preset', () => {
    const r = applyMode({ q: 'x', mode: 'impact', expandDepth: 1, topK: 3 });
    expect(r.expandDepth).toBe(1); // explicit wins over preset's 2
    expect(r.topK).toBe(3);
  });

  it('debug boosts bm25 over vector', () => {
    const r = applyMode({ q: 'x', mode: 'debug' });
    expect(r.bm25Weight!).toBeGreaterThan(r.vectorWeight!);
  });

  it('unknown or absent mode leaves the request unchanged', () => {
    const base = { q: 'x', topK: 7 };
    expect(applyMode(base)).toEqual(base);
    expect(applyMode({ ...base, mode: 'nope' })).toEqual({ ...base, mode: 'nope' });
  });

  it('preserves non-preset fields (q, domains, productId)', () => {
    const r = applyMode({ q: 'hi', mode: 'code', domains: ['api'], productId: 'p1' });
    expect(r.q).toBe('hi');
    expect(r.domains).toEqual(['api']);
    expect(r.productId).toBe('p1');
  });
});

// ─── Pure fusion logic — no Neo4j, always runs ───────────────────────────
describe('graphScoreFor — MAX-based, hub-safe', () => {
  const seedScores = new Map([
    ['s1', 0.8],
    ['s2', 0.7],
  ]);

  it('takes the max seed pull, not the sum (no hub accumulation)', () => {
    // A node reached by two strong seeds at 1 hop scores 0.8 (max), NOT 1.5.
    const score = graphScoreFor(
      [
        { seedId: 's1', dist: 1 },
        { seedId: 's2', dist: 1 },
      ],
      seedScores,
    );
    expect(score).toBeCloseTo(0.8);
  });

  it('a node touched by many weak seeds never beats one strong link', () => {
    const many = graphScoreFor(
      [
        { seedId: 's2', dist: 1 },
        { seedId: 's2', dist: 1 },
        { seedId: 's2', dist: 1 },
      ],
      seedScores,
    );
    const oneStrong = graphScoreFor([{ seedId: 's1', dist: 1 }], seedScores);
    expect(oneStrong).toBeGreaterThan(many);
  });

  it('decays pull by hop distance', () => {
    const oneHop = graphScoreFor([{ seedId: 's1', dist: 1 }], seedScores);
    const twoHop = graphScoreFor([{ seedId: 's1', dist: 2 }], seedScores);
    expect(twoHop).toBeCloseTo(oneHop * QUERY_HOP_DECAY);
  });

  it('scales pull by relationship weight', () => {
    const full = graphScoreFor([{ seedId: 's1', dist: 1, weight: 1.0 }], seedScores);
    const weak = graphScoreFor([{ seedId: 's1', dist: 1, weight: 0.5 }], seedScores);
    expect(weak).toBeCloseTo(full * 0.5);
  });

  it('missing weight is treated as 1.0 (back-compat)', () => {
    const withW = graphScoreFor([{ seedId: 's1', dist: 1, weight: 1.0 }], seedScores);
    const noW = graphScoreFor([{ seedId: 's1', dist: 1 }], seedScores);
    expect(noW).toBeCloseTo(withW);
  });

  it('soft-dampens by neighbor degree when enabled (IDF-style)', () => {
    const reach = [{ seedId: 's1', dist: 1, weight: 1.0 }];
    const plain = graphScoreFor(reach, seedScores);
    const dampedLow = graphScoreFor(reach, seedScores, { degree: 4, dampen: true });
    const dampedHigh = graphScoreFor(reach, seedScores, { degree: 500, dampen: true });
    // Dampening only reduces, and a higher-degree hub is reduced more.
    expect(dampedLow).toBeLessThan(plain);
    expect(dampedHigh).toBeLessThan(dampedLow);
    // Off by default — no degree effect unless dampen:true.
    expect(graphScoreFor(reach, seedScores, { degree: 500 })).toBeCloseTo(plain);
  });
});

describe('rrfFuse — reciprocal rank fusion over vector/bm25/graph', () => {
  const cand = (id: string, scores: Partial<Candidate>): Candidate => ({
    nodeId: id,
    label: 'Function',
    properties: {},
    ...scores,
  });

  it('rewards multi-signal agreement: a node strong in two signals beats one strong in a single signal', () => {
    const both = cand('both', { vectorScore: 0.9, bm25Score: 8 }); // #1 vector AND #1 bm25
    const vOnly = cand('v-only', { vectorScore: 0.95 }); // #1 vector only (but higher raw)
    const bOnly = cand('b-only', { bm25Score: 9 }); // #1 bm25 only
    const hits = rrfFuse([vOnly, bOnly, both], EQUAL, 3);
    expect(hits[0]!.nodeId).toBe('both');
    expect(hits[0]!.via).toBe('vector+bm25');
  });

  it('fuses by rank, not raw magnitude — huge BM25 numbers do not swamp vector', () => {
    // bm25 scores are ~10x the cosine scale; RRF must not let that dominate.
    const a = cand('a', { vectorScore: 0.9, bm25Score: 1 }); // vec #1, bm25 #2
    const b = cand('b', { vectorScore: 0.1, bm25Score: 50 }); // vec #2, bm25 #1
    const hits = rrfFuse([a, b], EQUAL, 2);
    // Both are rank-1 in one signal and rank-2 in the other → effectively tied,
    // NOT dominated by b's raw bm25 of 50.
    expect(Math.abs(hits[0]!.score - hits[1]!.score)).toBeLessThan(1e-9);
  });

  it('a graph-only neighbor surfaces, tagged via=graph', () => {
    const hits = rrfFuse(
      [cand('v', { vectorScore: 0.9 }), cand('g', { graphScore: 0.7 })],
      { vector: 1, bm25: 1, graph: 1 },
      2,
    );
    const g = hits.find((h) => h.nodeId === 'g');
    expect(g?.via).toBe('graph');
  });

  it('weight 0 removes a signal from fusion', () => {
    // graph weight 0 → a graph-only node contributes nothing, ranks last.
    const hits = rrfFuse(
      [cand('v', { vectorScore: 0.5 }), cand('g', { graphScore: 0.99 })],
      { vector: 1, bm25: 1, graph: 0 },
      2,
    );
    expect(hits[0]!.nodeId).toBe('v');
  });

  it('normalizes scores to [0, 1], descending', () => {
    const hits = rrfFuse(
      [cand('a', { vectorScore: 0.9 }), cand('b', { vectorScore: 0.5, bm25Score: 3 })],
      EQUAL,
      2,
    );
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
    for (const h of hits) {
      expect(h.score).toBeGreaterThanOrEqual(0);
      expect(h.score).toBeLessThanOrEqual(1);
    }
    expect(hits[0]!.score).toBeCloseTo(1); // top normalized to 1
  });
});

const RUN_INTEGRATION = process.env.RUN_NEO4J_INTEGRATION === '1';
const NEO4J_URL = process.env.NEO4J_TEST_URL ?? 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_TEST_USER ?? 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_TEST_PASSWORD ?? 'devpassword';
const EMBEDDER_URL = process.env.EMBEDDER_TEST_URL ?? 'http://localhost:12434/engines/llama.cpp/v1';
const EMBEDDER_MODEL = process.env.EMBEDDER_TEST_MODEL ?? 'ai/qwen3-embedding:0.6B-F16';

const RUN_ID = `t${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
const LABEL = `Symbol_${RUN_ID}`;

describe.skipIf(!RUN_INTEGRATION)('ContextQueryService — real vector search', () => {
  let backend: Neo4jBackend;
  let svc: ContextQueryService;

  beforeAll(async () => {
    backend = new Neo4jBackend({
      url: NEO4J_URL,
      user: NEO4J_USER,
      password: NEO4J_PASSWORD,
      vectorDim: 1024,
    });
    await backend.ensureSchema({ nodes: [LABEL], edges: [] });

    // Seed a handful of distinguishable docs. The embedder is real —
    // each text gets a real qwen embedding written to Neo4j.
    const docs: Array<{ id: string; text: string }> = [
      { id: 'd-database', text: 'connecting to a postgres database with prepared statements' },
      { id: 'd-frontend', text: 'rendering a React component with hooks and useState' },
      { id: 'd-cooking', text: 'how to make pasta carbonara with eggs and guanciale' },
      { id: 'd-graph', text: 'cypher query to traverse a property graph in neo4j' },
    ];
    await backend.upsertNodesBulk(
      docs.map((d) => ({
        id: d.id,
        label: LABEL,
        properties: { text: d.text },
        sourceTypeId: 'test',
        sourceId: 'query-test-product',
      })),
    );

    // Embed each doc via the same embedder the query path uses, so
    // they live in one vector space.
    const { createHttpEmbedderClient } = await import('@ecruz165/context-loader-core');
    const embedder = createHttpEmbedderClient({
      config: { url: EMBEDDER_URL, model: EMBEDDER_MODEL, dim: 1024 },
    });
    const vectors = await embedder.embed(docs.map((d) => d.text));
    await backend.upsertVectorsBulk(
      docs.map((d, i) => ({
        nodeId: d.id,
        vector: vectors[i]!,
        meta: { kind: 'test' },
      })),
    );

    svc = new ContextQueryService({
      neo4jUrl: NEO4J_URL,
      neo4jUser: NEO4J_USER,
      neo4jPassword: NEO4J_PASSWORD,
      embedderUrl: EMBEDDER_URL,
      embedderModel: EMBEDDER_MODEL,
      embedderDim: 1024,
    });
  }, 60_000);

  afterAll(async () => {
    if (svc) await svc.close();
    if (backend) {
      // Best-effort teardown — drop the test label's nodes only.
      const session = (
        backend as unknown as { driver: { session(): unknown } }
      ).driver.session() as {
        run(q: string): Promise<unknown>;
        close(): Promise<void>;
      };
      try {
        await session.run(`MATCH (n:\`${LABEL}\`) DETACH DELETE n`);
      } finally {
        await session.close();
      }
      await backend.close();
    }
  });

  it('ranks the most semantically similar node first', async () => {
    // NB: avoid boilerplate question words ("how do I …") here — in this
    // tiny 4-doc corpus BM25's IDF is inverted, so a near-stopword shared
    // with an off-topic doc (e.g. "how" in the pasta recipe) gets scored as
    // rare+important and pollutes the ranking. Real corpora self-suppress
    // such terms via IDF; the synthetic corpus doesn't.
    const r = await svc.query({
      q: 'writing SQL queries against a postgres database',
      topK: 4,
      labels: [LABEL],
    });
    expect(r.hits).toHaveLength(4);
    expect(r.hits[0]!.nodeId).toBe('d-database');
    // Cooking should rank last — it's wildly off-topic.
    const cookingRank = r.hits.findIndex((h) => h.nodeId === 'd-cooking');
    expect(cookingRank).toBe(3);
  }, 30_000);

  it('returns normalized fused scores in [0, 1], descending', async () => {
    const r = await svc.query({ q: 'graph database query language', topK: 4, labels: [LABEL] });
    for (let i = 1; i < r.hits.length; i++) {
      expect(r.hits[i - 1]!.score).toBeGreaterThanOrEqual(r.hits[i]!.score);
    }
    for (const h of r.hits) {
      expect(h.score).toBeGreaterThanOrEqual(0);
      expect(h.score).toBeLessThanOrEqual(1);
    }
    // The graph-related doc is closest.
    expect(r.hits[0]!.nodeId).toBe('d-graph');
  }, 30_000);

  it('strips embedding properties from returned hits', async () => {
    const r = await svc.query({ q: 'anything', topK: 1, labels: [LABEL] });
    expect(r.hits[0]!.properties.embedding).toBeUndefined();
    expect(r.hits[0]!.properties.embeddingMeta).toBeUndefined();
    // The actual content properties should still be there.
    expect(typeof r.hits[0]!.properties.text).toBe('string');
  }, 30_000);

  it('honors productId scoping via sourceId STARTS WITH', async () => {
    const r = await svc.query({
      q: 'database',
      productId: 'query-test-product',
      labels: [LABEL],
    });
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) {
      expect(h.sourceId).toBe('query-test-product');
    }

    const empty = await svc.query({
      q: 'database',
      productId: 'no-such-product',
      labels: [LABEL],
    });
    expect(empty.hits).toHaveLength(0);
  }, 30_000);

  it('reports embedding + search timings', async () => {
    const r = await svc.query({ q: 'quick test', labels: [LABEL] });
    expect(r.embeddingMs).toBeGreaterThan(0);
    expect(r.searchMs).toBeGreaterThanOrEqual(0);
  }, 30_000);
});

// ─── Hybrid BM25 + RRF — needs the full-text index from ensureSchema ──────
const HLABEL = `Hybrid_${RUN_ID}`;

/** Hack into the backend's private driver to run raw Cypher (await-indexes,
 *  teardown) — mirrors the teardown pattern in the block above. */
type RawSession = { run(q: string): Promise<unknown>; close(): Promise<void> };
function rawSession(backend: Neo4jBackend): RawSession {
  return (backend as unknown as { driver: { session(): RawSession } }).driver.session();
}

describe.skipIf(!RUN_INTEGRATION)('ContextQueryService — hybrid BM25 + RRF', () => {
  let backend: Neo4jBackend;
  let svc: ContextQueryService;

  beforeAll(async () => {
    backend = new Neo4jBackend({
      url: NEO4J_URL,
      user: NEO4J_USER,
      password: NEO4J_PASSWORD,
      vectorDim: 1024,
    });
    // ensureSchema now also creates `<Label>_fts_idx` — the BM25 index.
    await backend.ensureSchema({ nodes: [HLABEL], edges: [] });

    const docs: Array<{ id: string; text: string }> = [
      { id: 'h-auth', text: 'user authentication and login session handling with tokens' },
      // A rare exact token the embedder has no good representation for.
      { id: 'h-errcode', text: 'the gateway raises ERRXQ7TOKEN when the upstream service times out' },
      { id: 'h-ui', text: 'rendering a responsive navigation bar in the web frontend' },
      { id: 'h-db', text: 'running database schema migrations safely in production' },
    ];
    await backend.upsertNodesBulk(
      docs.map((d) => ({
        id: d.id,
        label: HLABEL,
        properties: { text: d.text },
        sourceTypeId: 'test',
        sourceId: 'hybrid-test-product',
      })),
    );

    const { createHttpEmbedderClient } = await import('@ecruz165/context-loader-core');
    const embedder = createHttpEmbedderClient({
      config: { url: EMBEDDER_URL, model: EMBEDDER_MODEL, dim: 1024 },
    });
    const vectors = await embedder.embed(docs.map((d) => d.text));
    await backend.upsertVectorsBulk(
      docs.map((d, i) => ({ nodeId: d.id, vector: vectors[i]!, meta: { kind: 'test' } })),
    );

    // Make sure both vector + full-text indexes are online & populated before
    // querying — avoids a flaky empty-BM25 race on a freshly-created index.
    const s = rawSession(backend);
    try {
      await s.run('CALL db.awaitIndexes(30)');
    } finally {
      await s.close();
    }

    svc = new ContextQueryService({
      neo4jUrl: NEO4J_URL,
      neo4jUser: NEO4J_USER,
      neo4jPassword: NEO4J_PASSWORD,
      embedderUrl: EMBEDDER_URL,
      embedderModel: EMBEDDER_MODEL,
      embedderDim: 1024,
    });
  }, 60_000);

  afterAll(async () => {
    if (svc) await svc.close();
    if (backend) {
      const session = rawSession(backend);
      try {
        await session.run(`MATCH (n:\`${HLABEL}\`) DETACH DELETE n`);
      } finally {
        await session.close();
      }
      await backend.close();
    }
  });

  it('BM25 lifts an exact token to the top (lexical signal vector lacks)', async () => {
    // Querying the rare token — vector alone has little to grab onto.
    const hybrid = await svc.query({ q: 'ERRXQ7TOKEN', topK: 4, labels: [HLABEL] });
    const vectorOnly = await svc.query({
      q: 'ERRXQ7TOKEN',
      topK: 4,
      labels: [HLABEL],
      bm25Weight: 0,
      graphWeight: 0,
    });

    const hybridRank = hybrid.hits.findIndex((h) => h.nodeId === 'h-errcode');
    const vectorRank = vectorOnly.hits.findIndex((h) => h.nodeId === 'h-errcode');

    // With BM25 fused in, the exact-token doc is #1 and BM25 is credited.
    expect(hybridRank).toBe(0);
    expect(hybrid.hits[0]!.via).toContain('bm25');
    // Lexical signal can only help — never ranks the exact match worse.
    expect(hybridRank).toBeLessThanOrEqual(vectorRank);
  }, 30_000);

  it('bm25 drives ranking when vector + graph weights are 0', async () => {
    const r = await svc.query({
      q: 'ERRXQ7TOKEN',
      topK: 4,
      labels: [HLABEL],
      vectorWeight: 0,
      graphWeight: 0,
    });
    expect(r.hits[0]!.nodeId).toBe('h-errcode');
    expect(r.hits[0]!.via).toContain('bm25');
  }, 30_000);

  it('a doc matched both semantically and lexically is tagged via=vector+bm25', async () => {
    const r = await svc.query({ q: 'user authentication login', topK: 4, labels: [HLABEL] });
    expect(r.hits[0]!.nodeId).toBe('h-auth');
    expect(r.hits[0]!.via).toContain('vector');
    expect(r.hits[0]!.via).toContain('bm25');
  }, 30_000);
});

// ─── Tier 4: relationship-weighted graph expansion ───────────────────────
const TLABEL = `Tier4_${RUN_ID}`;

describe.skipIf(!RUN_INTEGRATION)('ContextQueryService — weighted graph expansion', () => {
  let backend: Neo4jBackend;
  let svc: ContextQueryService;

  beforeAll(async () => {
    backend = new Neo4jBackend({
      url: NEO4J_URL,
      user: NEO4J_USER,
      password: NEO4J_PASSWORD,
      vectorDim: 1024,
    });
    await backend.ensureSchema({ nodes: [TLABEL], edges: ['CALLS', 'MENTIONS'] });

    // One semantically-distinct seed (gets an embedding) with two graph-only
    // neighbors reached by edges of different types — same hop, same seed pull,
    // so any rank difference comes purely from relationship weighting.
    const seed = { id: 't4-seed', text: 'rate limiter using a token bucket algorithm' };
    const neighbors = [
      { id: 't4-call', text: 'internal helper alpha widget routine' }, // via CALLS
      { id: 't4-mention', text: 'internal helper beta gadget routine' }, // via MENTIONS
    ];
    await backend.upsertNodesBulk(
      [seed, ...neighbors].map((d) => ({
        id: d.id,
        label: TLABEL,
        properties: { text: d.text },
        sourceTypeId: 'test',
        sourceId: 'tier4-test-product',
      })),
    );
    await backend.upsertEdgesBulk([
      { from: 't4-seed', to: 't4-call', label: 'CALLS', sourceTypeId: 'test' },
      { from: 't4-seed', to: 't4-mention', label: 'MENTIONS', sourceTypeId: 'test' },
    ]);

    // Only the seed gets a vector — the neighbors must arrive via expansion.
    const { createHttpEmbedderClient } = await import('@ecruz165/context-loader-core');
    const embedder = createHttpEmbedderClient({
      config: { url: EMBEDDER_URL, model: EMBEDDER_MODEL, dim: 1024 },
    });
    const [seedVec] = await embedder.embed([seed.text]);
    await backend.upsertVectorsBulk([{ nodeId: 't4-seed', vector: seedVec!, meta: { kind: 'test' } }]);

    const s = rawSession(backend);
    try {
      await s.run('CALL db.awaitIndexes(30)');
    } finally {
      await s.close();
    }

    svc = new ContextQueryService({
      neo4jUrl: NEO4J_URL,
      neo4jUser: NEO4J_USER,
      neo4jPassword: NEO4J_PASSWORD,
      embedderUrl: EMBEDDER_URL,
      embedderModel: EMBEDDER_MODEL,
      embedderDim: 1024,
    });
  }, 60_000);

  afterAll(async () => {
    if (svc) await svc.close();
    if (backend) {
      const session = rawSession(backend);
      try {
        await session.run(`MATCH (n:\`${TLABEL}\`) DETACH DELETE n`);
      } finally {
        await session.close();
      }
      await backend.close();
    }
  });

  it('default weights rank a CALLS neighbor above a MENTIONS neighbor', async () => {
    const r = await svc.query({ q: 'token bucket rate limiter', topK: 4, labels: [TLABEL] });
    expect(r.hits[0]!.nodeId).toBe('t4-seed'); // the vector/bm25 match
    const callRank = r.hits.findIndex((h) => h.nodeId === 't4-call');
    const mentionRank = r.hits.findIndex((h) => h.nodeId === 't4-mention');
    expect(callRank).toBeGreaterThanOrEqual(0);
    expect(mentionRank).toBeGreaterThanOrEqual(0);
    // CALLS (weight 1.0) outranks MENTIONS (0.5); both arrived via graph.
    expect(callRank).toBeLessThan(mentionRank);
    expect(r.hits[callRank]!.via).toBe('graph');
    expect(r.hits[mentionRank]!.via).toBe('graph');
  }, 30_000);

  it('overriding predicate weights flips the neighbor order', async () => {
    const r = await svc.query({
      q: 'token bucket rate limiter',
      topK: 4,
      labels: [TLABEL],
      expandPredicateWeights: { CALLS: 0.3, MENTIONS: 1.0 },
    });
    const callRank = r.hits.findIndex((h) => h.nodeId === 't4-call');
    const mentionRank = r.hits.findIndex((h) => h.nodeId === 't4-mention');
    expect(mentionRank).toBeLessThan(callRank);
  }, 30_000);
});

// ─── Tier 2: domain filtering ────────────────────────────────────────────
const DLABEL = `Domain_${RUN_ID}`;

describe.skipIf(!RUN_INTEGRATION)('ContextQueryService — domain filtering', () => {
  let backend: Neo4jBackend;
  let svc: ContextQueryService;

  beforeAll(async () => {
    backend = new Neo4jBackend({
      url: NEO4J_URL,
      user: NEO4J_USER,
      password: NEO4J_PASSWORD,
      vectorDim: 1024,
    });
    await backend.ensureSchema({ nodes: [DLABEL], edges: [] });

    const docs = [
      { id: 'd-sec', text: 'verify and refresh the oauth access token', domain: 'security' },
      { id: 'd-ui', text: 'render the navigation sidebar component', domain: 'ui' },
      { id: 'd-api', text: 'handle the POST request to create a user', domain: 'api' },
    ];
    await backend.upsertNodesBulk(
      docs.map((d) => ({
        id: d.id,
        label: DLABEL,
        properties: { text: d.text, domain: d.domain },
        sourceTypeId: 'test',
        sourceId: 'domain-test-product',
      })),
    );

    const { createHttpEmbedderClient } = await import('@ecruz165/context-loader-core');
    const embedder = createHttpEmbedderClient({
      config: { url: EMBEDDER_URL, model: EMBEDDER_MODEL, dim: 1024 },
    });
    const vectors = await embedder.embed(docs.map((d) => d.text));
    await backend.upsertVectorsBulk(
      docs.map((d, i) => ({ nodeId: d.id, vector: vectors[i]!, meta: { kind: 'test' } })),
    );

    const s = rawSession(backend);
    try {
      await s.run('CALL db.awaitIndexes(30)');
    } finally {
      await s.close();
    }

    svc = new ContextQueryService({
      neo4jUrl: NEO4J_URL,
      neo4jUser: NEO4J_USER,
      neo4jPassword: NEO4J_PASSWORD,
      embedderUrl: EMBEDDER_URL,
      embedderModel: EMBEDDER_MODEL,
      embedderDim: 1024,
    });
  }, 60_000);

  afterAll(async () => {
    if (svc) await svc.close();
    if (backend) {
      const session = rawSession(backend);
      try {
        await session.run(`MATCH (n:\`${DLABEL}\`) DETACH DELETE n`);
      } finally {
        await session.close();
      }
      await backend.close();
    }
  });

  it('restricts results to the requested domain', async () => {
    const r = await svc.query({
      q: 'oauth token refresh',
      topK: 5,
      labels: [DLABEL],
      domains: ['security'],
    });
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) expect(h.domain).toBe('security');
    expect(r.hits.some((h) => h.nodeId === 'd-sec')).toBe(true);
    expect(r.hits.some((h) => h.nodeId === 'd-ui' || h.nodeId === 'd-api')).toBe(false);
  }, 30_000);

  it('surfaces the domain on each hit and spans domains when unfiltered', async () => {
    const r = await svc.query({ q: 'oauth token refresh', topK: 5, labels: [DLABEL] });
    expect(r.hits[0]!.domain).toBe('security'); // best semantic match
    expect(new Set(r.hits.map((h) => h.domain)).size).toBeGreaterThan(1);
  }, 30_000);

  it('a multi-domain filter excludes the others', async () => {
    const r = await svc.query({
      q: 'create user request',
      topK: 5,
      labels: [DLABEL],
      domains: ['ui', 'api'],
    });
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) expect(['ui', 'api']).toContain(h.domain);
  }, 30_000);
});

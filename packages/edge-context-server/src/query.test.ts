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
import { ContextQueryService } from './query.ts';

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
    const r = await svc.query({
      q: 'how do I write SQL against postgres',
      topK: 4,
      labels: [LABEL],
    });
    expect(r.hits).toHaveLength(4);
    expect(r.hits[0]!.nodeId).toBe('d-database');
    // Cooking should rank last — it's wildly off-topic.
    const cookingRank = r.hits.findIndex((h) => h.nodeId === 'd-cooking');
    expect(cookingRank).toBe(3);
  }, 30_000);

  it('returns scores in descending order with cosine in [0, 1]', async () => {
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

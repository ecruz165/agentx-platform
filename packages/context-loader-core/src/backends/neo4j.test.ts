/**
 * Integration tests for Neo4jBackend.
 *
 * Gated behind RUN_NEO4J_INTEGRATION=1 because they require a live Neo4j
 * server. Local dev: bring up `docker compose up neo4j-edge` from
 * workspace-template/.devcontainer/, set NEO4J_TEST_URL and
 * NEO4J_TEST_PASSWORD, then run:
 *
 *   RUN_NEO4J_INTEGRATION=1 NEO4J_TEST_URL=bolt://localhost:7687 \
 *     NEO4J_TEST_PASSWORD=devpassword \
 *     pnpm --filter @agentx/context-loader-core test
 *
 * CI: bring up Neo4j via testcontainers in a separate setup file (future).
 *
 * The tests use a unique label suffix per test run so concurrent test runs
 * don't collide and don't have to clean up between runs.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Neo4jBackend } from './neo4j.ts';
import type { GraphNode, GraphEdge, SourceTypeSchema } from '../types.ts';

/** Coerce a Neo4j scalar (JS number OR neo4j-driver Integer) to a JS number.
 *  Aggregates like count() return Integer; plain numeric properties round-trip
 *  as JS numbers. Tests don't care about the distinction. */
function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber();
  }
  return Number(v);
}

const RUN_INTEGRATION = process.env.RUN_NEO4J_INTEGRATION === '1';
const NEO4J_URL = process.env.NEO4J_TEST_URL ?? 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_TEST_USER ?? 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_TEST_PASSWORD ?? 'devpassword';

// Unique-per-run label suffix so we don't trip over leftover state from
// previous failed runs and so concurrent CI shards don't fight.
const RUN_ID = `t${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
const NODE_LABEL = `TestDoc_${RUN_ID}`;
const EDGE_LABEL = `TestLinks_${RUN_ID}`;

describe.skipIf(!RUN_INTEGRATION)('Neo4jBackend integration', () => {
  let backend: Neo4jBackend;

  beforeAll(() => {
    backend = new Neo4jBackend({
      url: NEO4J_URL,
      user: NEO4J_USER,
      password: NEO4J_PASSWORD,
      vectorDim: 8, // small dim for fast tests
    });
  });

  afterAll(async () => {
    // Clean up the test labels' nodes (CASCADE-deletes any test edges).
    // Then close the driver.
    const session = (backend as unknown as { driver: { session(): unknown } }).driver.session() as {
      run(q: string): Promise<unknown>;
      close(): Promise<void>;
    };
    try {
      await session.run(`MATCH (n:\`${NODE_LABEL}\`) DETACH DELETE n`);
    } finally {
      await session.close();
    }
    await backend.close();
  });

  beforeEach(async () => {
    // Each test starts with the schema ensured (idempotent — safe to repeat)
    const schema: SourceTypeSchema = {
      nodes: [NODE_LABEL],
      edges: [EDGE_LABEL],
    };
    await backend.ensureSchema(schema);
  });

  it('upserts nodes idempotently via MERGE on id', async () => {
    const node: GraphNode = {
      id: 'doc-1',
      label: NODE_LABEL,
      properties: { title: 'First', wordCount: 42 },
      sourceTypeId: 'prose-markdown',
      sourceId: 'test',
    };
    await backend.upsertNode(node);
    // Re-upserting with different props should update, not create a duplicate.
    await backend.upsertNode({ ...node, properties: { title: 'First', wordCount: 100 } });

    const session = (backend as unknown as { driver: { session(): unknown } }).driver.session() as {
      run(q: string, p?: object): Promise<{ records: Array<{ get(k: string): unknown }> }>;
      close(): Promise<void>;
    };
    try {
      const r = await session.run(
        `MATCH (n:\`${NODE_LABEL}\` {id: 'doc-1'}) RETURN count(n) AS c, n.wordCount AS w`
      );
      expect(asNumber(r.records[0]!.get('c'))).toBe(1);
      expect(asNumber(r.records[0]!.get('w'))).toBe(100);
    } finally {
      await session.close();
    }
  });

  it('upserts edges between existing nodes', async () => {
    const a: GraphNode = {
      id: 'a',
      label: NODE_LABEL,
      properties: {},
      sourceTypeId: 'prose-markdown',
      sourceId: 'test',
    };
    const b: GraphNode = { ...a, id: 'b' };
    await backend.upsertNodesBulk([a, b]);

    const edge: GraphEdge = {
      from: 'a',
      to: 'b',
      label: EDGE_LABEL,
      properties: { weight: 0.5 },
      sourceTypeId: 'prose-markdown',
    };
    await backend.upsertEdge(edge);

    const session = (backend as unknown as { driver: { session(): unknown } }).driver.session() as {
      run(q: string): Promise<{ records: Array<{ get(k: string): unknown }> }>;
      close(): Promise<void>;
    };
    try {
      const r = await session.run(
        `MATCH (a:\`${NODE_LABEL}\` {id: 'a'})-[r:\`${EDGE_LABEL}\`]->(b:\`${NODE_LABEL}\` {id: 'b'})
         RETURN count(r) AS c`
      );
      expect(asNumber(r.records[0]!.get('c'))).toBe(1);
    } finally {
      await session.close();
    }
  });

  it('upserts vectors with the correct dim and stores them on the node', async () => {
    const node: GraphNode = {
      id: 'vec-node',
      label: NODE_LABEL,
      properties: {},
      sourceTypeId: 'prose-markdown',
      sourceId: 'test',
    };
    await backend.upsertNode(node);

    const v = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await backend.upsertVector('vec-node', v, { kind: 'test' });

    const session = (backend as unknown as { driver: { session(): unknown } }).driver.session() as {
      run(q: string): Promise<{ records: Array<{ get(k: string): unknown }> }>;
      close(): Promise<void>;
    };
    try {
      const r = await session.run(
        `MATCH (n:\`${NODE_LABEL}\` {id: 'vec-node'}) RETURN n.embedding AS e`
      );
      const stored = r.records[0]!.get('e') as number[];
      expect(stored).toHaveLength(8);
      expect(stored[0]).toBeCloseTo(1, 5);
      expect(stored[7]).toBeCloseTo(8, 5);
    } finally {
      await session.close();
    }
  });

  it('rejects vectors with the wrong dim before sending', async () => {
    const wrongDim = new Float32Array(4); // backend expects 8
    await expect(
      backend.upsertVector('any-id', wrongDim, {})
    ).rejects.toThrow(/dim mismatch/);
  });

  it('rejects unsafe label characters at every entry point', async () => {
    const unsafeNode: GraphNode = {
      id: 'x',
      label: 'Bad Label; DROP DATABASE neo4j;',
      properties: {},
      sourceTypeId: 'prose-markdown',
      sourceId: 'test',
    };
    await expect(backend.upsertNode(unsafeNode)).rejects.toThrow(/invalid node label/);

    const unsafeEdge: GraphEdge = {
      from: 'x',
      to: 'y',
      label: 'Bad Edge`Label',
      properties: {},
      sourceTypeId: 'prose-markdown',
    };
    await expect(backend.upsertEdge(unsafeEdge)).rejects.toThrow(/invalid edge label/);
  });
});

// Always-on unit-level tests that don't need a server: validate the
// label-injection guards and the constructor-shape contract.
describe('Neo4jBackend — server-free unit checks', () => {
  it('label-injection guard rejects unsafe labels', async () => {
    // We can construct the backend without a server (no connection until
    // first query). Pass a deliberately unreachable URL — the test never
    // actually issues a query.
    const backend = new Neo4jBackend({
      url: 'bolt://this-host-does-not-exist:7687',
      password: 'unused',
    });
    try {
      const unsafe: GraphNode = {
        id: 'x',
        label: 'OK; MATCH (n) DETACH DELETE n;',
        properties: {},
        sourceTypeId: 'prose-markdown',
        sourceId: 'test',
      };
      await expect(backend.upsertNode(unsafe)).rejects.toThrow(/invalid node label/);
    } finally {
      await backend.close();
    }
  });

  it('vector-dim guard fires before any network call', async () => {
    const backend = new Neo4jBackend({
      url: 'bolt://this-host-does-not-exist:7687',
      password: 'unused',
      vectorDim: 1024,
    });
    try {
      const wrongDim = new Float32Array(8);
      await expect(
        backend.upsertVector('any', wrongDim, {})
      ).rejects.toThrow(/dim mismatch/);
    } finally {
      await backend.close();
    }
  });
});

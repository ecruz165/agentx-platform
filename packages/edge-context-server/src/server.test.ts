/**
 * HTTP/UDS round-trip tests for the edge-context-server. Exercises the
 * route surface (/health, /v1/stats, /v1/context/query) with a stub
 * QueryService so no live Neo4j is needed. Real-Neo4j integration
 * lives in query.test.ts (gated behind RUN_NEO4J_INTEGRATION=1).
 *
 * These tests pin the contract the server holds with its callers:
 *   - response shapes
 *   - status codes
 *   - backend-error vs no-backend states on /health
 *   - graceful error propagation when the backend throws
 */

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startContextServer } from './index.ts';
import type {
  ContextQueryRequest,
  ContextQueryResult,
  ContextStatsResult,
  CypherRequest,
  CypherResult,
  QueryService,
  RelatedRequest,
  RelatedResult,
  TraverseRequest,
  TraverseResult,
} from './query.ts';

const tmpSocket = () => join(tmpdir(), `ctx-${randomUUID().slice(0, 8)}.sock`);

interface UdsResponse {
  status: number;
  body: any;
}

function udsJson(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<UdsResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path, method, headers: body ? { 'content-type': 'application/json' } : {} },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c.toString()));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: buf ? JSON.parse(buf) : null });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * In-memory stub of QueryService — returns canned hits for matching
 * queries, deterministic stats. Lets the server tests exercise their
 * route surface end-to-end without docker/Neo4j.
 */
class StubQueryService implements QueryService {
  closed = false;
  failNextStats = false;
  /** Records the last call args for each method, so tests can assert
   *  that the route correctly forwarded body fields. */
  lastTraverse?: TraverseRequest;
  lastRelated?: RelatedRequest;
  lastCypher?: CypherRequest;

  constructor(
    private readonly canned: {
      hits?: ContextQueryResult['hits'];
      stats?: ContextStatsResult;
      traverse?: TraverseResult;
      related?: RelatedResult;
      cypher?: CypherResult;
    } = {},
  ) {}

  async query(req: ContextQueryRequest): Promise<ContextQueryResult> {
    return {
      q: req.q,
      productId: req.productId,
      hits: this.canned.hits ?? [],
      searchedLabels: req.labels ?? ['Symbol'],
      topK: req.topK ?? 10,
      embeddingMs: 1,
      searchMs: 1,
    };
  }

  async stats(): Promise<ContextStatsResult> {
    if (this.failNextStats) {
      this.failNextStats = false;
      throw new Error('simulated neo4j connection error');
    }
    return (
      this.canned.stats ?? {
        nodeCount: 42,
        edgeCount: 17,
        indexedLabels: ['Symbol', 'Doc'],
        ts: new Date().toISOString(),
      }
    );
  }

  async traverse(req: TraverseRequest): Promise<TraverseResult> {
    this.lastTraverse = req;
    return (
      this.canned.traverse ?? {
        entity: req.entity,
        depth: req.depth,
        nodes: [
          { nodeId: req.entity, label: 'Function', properties: { name: req.entity }, distance: 0 },
          { nodeId: 'callee-1', label: 'Function', properties: { name: 'callee-1' }, distance: 1 },
        ],
        edges: [{ fromNodeId: req.entity, toNodeId: 'callee-1', type: 'CALLS', properties: {} }],
        truncated: false,
      }
    );
  }

  async related(req: RelatedRequest): Promise<RelatedResult> {
    this.lastRelated = req;
    return (
      this.canned.related ?? {
        entity: req.entity,
        predicate: req.predicate,
        depth: req.depth,
        hits: [
          { nodeId: 'r1', label: 'Doc', properties: { title: 'r1' }, distance: 1 },
        ],
        truncated: false,
      }
    );
  }

  async cypher(req: CypherRequest): Promise<CypherResult> {
    this.lastCypher = req;
    return (
      this.canned.cypher ?? {
        columns: ['n'],
        rows: [{ n: { _kind: 'node', labels: ['Function'], properties: { name: 'auth' } } }],
        rowCount: 1,
        truncated: false,
      }
    );
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe('edge-context-server — no backend wired', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('GET /health reports state=no-backend', async () => {
    const socketPath = tmpSocket();
    const handle = await startContextServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await udsJson(socketPath, 'GET', '/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.service).toBe('context');
    expect(r.body.state).toBe('no-backend');
    expect(typeof r.body.uptimeMs).toBe('number');
  });

  it('GET /v1/stats returns zero counts', async () => {
    const socketPath = tmpSocket();
    const handle = await startContextServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await udsJson(socketPath, 'GET', '/v1/stats');
    expect(r.status).toBe(200);
    expect(r.body.nodeCount).toBe(0);
    expect(r.body.edgeCount).toBe(0);
    expect(r.body.indexedLabels).toEqual([]);
  });

  it('POST /v1/context/query falls back to echo (v0 contract preserved)', async () => {
    const socketPath = tmpSocket();
    const handle = await startContextServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await udsJson(socketPath, 'POST', '/v1/context/query', { q: 'hello' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    // Echo path returns body.body containing the parsed request.
    expect(r.body.body).toEqual({ q: 'hello' });
  });
});

describe('edge-context-server — with stub backend', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('GET /health reports state=warm with backend stats', async () => {
    const socketPath = tmpSocket();
    const stub = new StubQueryService();
    const handle = await startContextServer({ socketPath, query: stub });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await udsJson(socketPath, 'GET', '/health');
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('warm');
    expect(r.body.backend).toBe('neo4j');
    expect(r.body.nodeCount).toBe(42);
    expect(r.body.edgeCount).toBe(17);
    expect(r.body.indexedLabels).toEqual(['Symbol', 'Doc']);
  });

  it('GET /health reports state=backend-error when stats throws', async () => {
    const socketPath = tmpSocket();
    const stub = new StubQueryService();
    stub.failNextStats = true;
    const handle = await startContextServer({ socketPath, query: stub });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await udsJson(socketPath, 'GET', '/health');
    expect(r.status).toBe(200); // 200 with state=backend-error, not 503
    expect(r.body.state).toBe('backend-error');
    expect(r.body.error).toMatch(/simulated neo4j/);
  });

  it('GET /v1/stats routes through to backend.stats()', async () => {
    const socketPath = tmpSocket();
    const stub = new StubQueryService({
      stats: { nodeCount: 1234, edgeCount: 567, indexedLabels: ['A'], ts: '2026-05-07T00:00:00Z' },
    });
    const handle = await startContextServer({ socketPath, query: stub });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await udsJson(socketPath, 'GET', '/v1/stats');
    expect(r.status).toBe(200);
    expect(r.body.nodeCount).toBe(1234);
    expect(r.body.edgeCount).toBe(567);
    expect(r.body.indexedLabels).toEqual(['A']);
  });

  it('POST /v1/context/query routes through to backend.query()', async () => {
    const socketPath = tmpSocket();
    const stub = new StubQueryService({
      hits: [
        {
          nodeId: 'n1',
          label: 'Symbol',
          score: 0.95,
          properties: { text: 'cached hit' },
          sourceId: 'web',
        },
      ],
    });
    const handle = await startContextServer({ socketPath, query: stub });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await udsJson(socketPath, 'POST', '/v1/context/query', {
      q: 'how do I auth?',
      productId: 'web',
      topK: 5,
    });
    expect(r.status).toBe(200);
    expect(r.body.result.hits).toHaveLength(1);
    expect(r.body.result.hits[0].nodeId).toBe('n1');
    expect(r.body.result.hits[0].score).toBe(0.95);
    expect(r.body.result.q).toBe('how do I auth?');
    expect(r.body.result.productId).toBe('web');
    expect(r.body.result.topK).toBe(5);
  });

  it('POST /v1/context/query with malformed body returns 400', async () => {
    const socketPath = tmpSocket();
    const handle = await startContextServer({
      socketPath,
      query: new StubQueryService(),
    });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await udsJson(socketPath, 'POST', '/v1/context/query', { notQ: 'oops' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/string `q`/);
  });

  it('stop() calls backend.close()', async () => {
    const socketPath = tmpSocket();
    const stub = new StubQueryService();
    const handle = await startContextServer({ socketPath, query: stub });
    expect(stub.closed).toBe(false);
    await handle.stop();
    await rm(socketPath, { force: true });
    expect(stub.closed).toBe(true);
  });
});

describe('edge-context-server — graphrag.* routes', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function spinUp(stub: StubQueryService) {
    const socketPath = tmpSocket();
    const handle = await startContextServer({ socketPath, query: stub });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });
    return socketPath;
  }

  it('POST /v1/traverse forwards args + returns subgraph', async () => {
    const stub = new StubQueryService();
    const socketPath = await spinUp(stub);

    const r = await udsJson(socketPath, 'POST', '/v1/traverse', {
      entity: 'AuthService',
      depth: 2,
      productId: 'web',
      predicates: ['CALLS', 'IMPORTS'],
    });
    expect(r.status).toBe(200);
    expect(r.body.result.entity).toBe('AuthService');
    expect(r.body.result.depth).toBe(2);
    expect(r.body.result.nodes).toHaveLength(2);
    expect(r.body.result.edges).toHaveLength(1);
    expect(stub.lastTraverse?.predicates).toEqual(['CALLS', 'IMPORTS']);
    expect(stub.lastTraverse?.productId).toBe('web');
  });

  it('POST /v1/traverse with missing entity returns 400', async () => {
    const stub = new StubQueryService();
    const socketPath = await spinUp(stub);
    const r = await udsJson(socketPath, 'POST', '/v1/traverse', { depth: 2 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/entity/);
  });

  it('POST /v1/traverse with missing depth returns 400', async () => {
    const stub = new StubQueryService();
    const socketPath = await spinUp(stub);
    const r = await udsJson(socketPath, 'POST', '/v1/traverse', { entity: 'X' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/depth/);
  });

  it('POST /v1/related forwards predicate + returns hits', async () => {
    const stub = new StubQueryService();
    const socketPath = await spinUp(stub);

    const r = await udsJson(socketPath, 'POST', '/v1/related', {
      entity: 'UserComponent',
      predicate: 'MENTIONS',
      depth: 1,
    });
    expect(r.status).toBe(200);
    expect(r.body.result.predicate).toBe('MENTIONS');
    expect(r.body.result.hits).toHaveLength(1);
    expect(stub.lastRelated?.predicate).toBe('MENTIONS');
  });

  it('POST /v1/related with missing predicate returns 400', async () => {
    const stub = new StubQueryService();
    const socketPath = await spinUp(stub);
    const r = await udsJson(socketPath, 'POST', '/v1/related', { entity: 'X', depth: 1 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/predicate/);
  });

  it('POST /v1/query (admin Cypher) forwards cypher + params', async () => {
    const stub = new StubQueryService();
    const socketPath = await spinUp(stub);

    const r = await udsJson(socketPath, 'POST', '/v1/query', {
      cypher: 'MATCH (n:Function) WHERE n.name = $name RETURN n',
      params: { name: 'auth' },
      limit: 50,
    });
    expect(r.status).toBe(200);
    expect(r.body.result.rowCount).toBe(1);
    expect(stub.lastCypher?.cypher).toMatch(/MATCH/);
    expect(stub.lastCypher?.params).toEqual({ name: 'auth' });
    expect(stub.lastCypher?.limit).toBe(50);
  });

  it('POST /v1/query with missing cypher returns 400', async () => {
    const stub = new StubQueryService();
    const socketPath = await spinUp(stub);
    const r = await udsJson(socketPath, 'POST', '/v1/query', { params: {} });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/cypher/);
  });

  it('POST /v1/traverse without backend returns 503', async () => {
    const socketPath = tmpSocket();
    const handle = await startContextServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });
    const r = await udsJson(socketPath, 'POST', '/v1/traverse', { entity: 'X', depth: 1 });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/backend/);
  });

  it('POST /v1/traverse propagates backend errors as 500', async () => {
    class FailingStub extends StubQueryService {
      override async traverse(): Promise<TraverseResult> {
        throw new Error('backend exploded');
      }
    }
    const stub = new FailingStub();
    const socketPath = await spinUp(stub);
    const r = await udsJson(socketPath, 'POST', '/v1/traverse', { entity: 'X', depth: 1 });
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/backend exploded/);
  });
});

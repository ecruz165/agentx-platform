import { chmod, mkdir, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import type { ContextQueryRequest, QueryService } from './query.ts';

export interface ContextServerOptions {
  socketPath: string;
  /** When provided, /v1/context/query + /v1/stats route to real backend.
   *  When absent, /v1/context/query falls back to echo behavior, /v1/stats
   *  reports zero counts, /health reports state='no-backend'. Tests can
   *  inject a stub QueryService to exercise the route surface without a
   *  live Neo4j. */
  query?: QueryService;
}

const STARTED_AT = Date.now();

export interface ContextServerHandle {
  stop(): Promise<void>;
}

/**
 * Edge context server — UDS REST surface in front of the local Neo4j
 * graph store. The two paths today:
 *   - GET  /health                  — liveness; returns { ok: true, … }
 *   - POST /v1/context/query        — vector-search retrieval; embeds the
 *                                     query text + searches Neo4j vector
 *                                     indexes per registered node label.
 *                                     Falls back to echo if no
 *                                     ContextQueryService is wired.
 *
 * Decision #2 keeps MCP banned: this server exposes REST/UDS only,
 * never an MCP surface. v1 trust model: socket file is mode 0600
 * (decision #5).
 */
export async function startContextServer(opts: ContextServerOptions): Promise<ContextServerHandle> {
  await mkdir(dirname(opts.socketPath), { recursive: true, mode: 0o700 });
  await unlink(opts.socketPath).catch(() => {});

  const server = createServer((req, res) => route(req, res, opts));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socketPath, () => resolve());
  });

  await chmod(opts.socketPath, 0o600);

  return {
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(opts.socketPath).catch(() => {});
      await opts.query?.close().catch(() => {});
    },
  };
}

function route(req: IncomingMessage, res: ServerResponse, opts: ContextServerOptions): void {
  const url = (req.url ?? '/').split('?')[0]!.replace(/\/$/, '') || '/';

  // GET /health — liveness + backend state. When no QueryService is wired,
  // reports state='no-backend' so monitors can distinguish "running" from
  // "running with backend." When wired, calls stats() to confirm Neo4j
  // is actually reachable; failure → state='backend-error' with reason.
  if (req.method === 'GET' && url === '/health') {
    if (!opts.query) {
      ok(res, {
        service: 'context',
        state: 'no-backend',
        uptimeMs: Date.now() - STARTED_AT,
        ts: new Date().toISOString(),
      });
      return;
    }
    opts.query
      .stats()
      .then((stats) =>
        ok(res, {
          service: 'context',
          state: 'warm',
          uptimeMs: Date.now() - STARTED_AT,
          backend: 'neo4j',
          nodeCount: stats.nodeCount,
          edgeCount: stats.edgeCount,
          indexedLabels: stats.indexedLabels,
          ts: new Date().toISOString(),
        }),
      )
      .catch((err: Error) => {
        // Backend unreachable — server is still alive but reads will
        // fail. 200 with state='backend-error' (not 503) so /health
        // distinguishes "process up" from "fully functional"; ops
        // monitors can branch on state, not status code.
        ok(res, {
          service: 'context',
          state: 'backend-error',
          uptimeMs: Date.now() - STARTED_AT,
          backend: 'neo4j',
          error: err.message,
          ts: new Date().toISOString(),
        });
      });
    return;
  }

  // GET /v1/stats — graph metrics. Same data as /health but without the
  // process-state envelope; intended for graph dashboards that just
  // want counts. No backend → zero counts (don't 404 — clients should
  // see a consistent shape even when the graph isn't wired).
  if (req.method === 'GET' && url === '/v1/stats') {
    if (!opts.query) {
      ok(res, {
        service: 'context',
        nodeCount: 0,
        edgeCount: 0,
        indexedLabels: [],
        ts: new Date().toISOString(),
      });
      return;
    }
    opts.query
      .stats()
      .then((stats) => ok(res, { service: 'context', ...stats }))
      .catch((err: Error) => serverError(res, err.message));
    return;
  }

  // POST /v1/context/query — body { q, productId?, topK?, labels? }.
  // With ContextQueryService wired: real vector search.
  // Without: echo (back-compat for tests + early bringup).
  if (req.method === 'POST' && url === '/v1/context/query') {
    let body = '';
    req.on('data', (c) => (body += c.toString()));
    req.on('end', async () => {
      const parsed = body ? safeJson(body) : null;
      if (!opts.query) {
        // Echo path — preserves the v0 contract for callers that don't
        // need real retrieval yet.
        ok(res, {
          service: 'context',
          method: req.method,
          path: req.url,
          body: parsed,
          ts: new Date().toISOString(),
        });
        return;
      }
      const reqBody = parsed as Partial<ContextQueryRequest> | null;
      if (!reqBody || typeof reqBody.q !== 'string') {
        badRequest(res, 'body must be JSON with a string `q` field');
        return;
      }
      try {
        const result = await opts.query.query({
          q: reqBody.q,
          productId: typeof reqBody.productId === 'string' ? reqBody.productId : undefined,
          topK: typeof reqBody.topK === 'number' ? reqBody.topK : undefined,
          labels: Array.isArray(reqBody.labels)
            ? reqBody.labels.filter((l) => typeof l === 'string')
            : undefined,
        });
        ok(res, { service: 'context', result, ts: new Date().toISOString() });
      } catch (err) {
        serverError(res, (err as Error).message);
      }
    });
    return;
  }

  // Fallback echo for any unknown path — useful for early bringup checks.
  echo(req, res, 'context');
}

function echo(req: IncomingMessage, res: ServerResponse, service: string): void {
  let body = '';
  req.on('data', (c) => (body += c.toString()));
  req.on('end', () => {
    ok(res, {
      service,
      method: req.method,
      path: req.url,
      body: body ? safeJson(body) : null,
      ts: new Date().toISOString(),
    });
  });
}

function ok(res: ServerResponse, payload: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, ...payload }));
}

function badRequest(res: ServerResponse, error: string): void {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error }));
}

function serverError(res: ServerResponse, error: string): void {
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error }));
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export type {
  ContextQueryHit,
  ContextQueryRequest,
  ContextQueryResult,
  ContextQueryServiceOptions,
  ContextStatsResult,
  QueryService,
} from './query.ts';
export { ContextQueryService } from './query.ts';

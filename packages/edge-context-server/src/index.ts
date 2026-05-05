import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ContextQueryService, type ContextQueryRequest } from './query.ts';

export interface ContextServerOptions {
  socketPath: string;
  /** When provided, /v1/context/query runs real Neo4j vector search
   *  against the configured backend + embedder. When absent, the
   *  endpoint falls back to the original echo behavior — useful for
   *  tests + early bringup before the triad's Neo4j is reachable. */
  query?: ContextQueryService;
}

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

function route(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ContextServerOptions
): void {
  const url = (req.url ?? '/').split('?')[0]!.replace(/\/$/, '') || '/';

  if (req.method === 'GET' && url === '/health') {
    ok(res, { ok: true, service: 'context', ts: new Date().toISOString() });
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
          labels: Array.isArray(reqBody.labels) ? reqBody.labels.filter((l) => typeof l === 'string') : undefined,
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

export { ContextQueryService } from './query.ts';
export type {
  ContextQueryServiceOptions,
  ContextQueryRequest,
  ContextQueryResult,
  ContextQueryHit,
} from './query.ts';

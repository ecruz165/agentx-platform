/**
 * Edge memory server — UDS REST surface in front of the local memory store.
 *
 * Routes:
 *   GET  /health             — liveness + backend state
 *   POST /v1/memory/put      — write an entry
 *   POST /v1/memory/query    — structured / recent retrieval
 *
 * Echo fallback retained for paths the store doesn't handle yet
 * (preserves the v0 contract for early-bringup callers + lets tests
 * exercise the route surface without a backend wired). Other PRD
 * routes (forget, recent-as-its-own-route, inspect, import/export,
 * tag, consolidate) land when their use cases do — v1-lite focuses
 * on the put/query loop the harness CLI's `harness memory query/put`
 * subcommands actually call today.
 *
 * Decision #2 keeps MCP banned: this server exposes REST/UDS only,
 * never MCP. v1 trust model: socket file is mode 0600 (decision #5).
 */

import { chmod, mkdir, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import {
  InMemoryMemoryStore,
  type MemoryPutInput,
  type MemoryQuery,
  type MemoryScope,
  type MemoryStore,
} from './store.ts';

export interface MemoryServerOptions {
  socketPath: string;
  /** Backend store. Defaults to a fresh InMemoryMemoryStore — useful
   *  for tests and dev. Production wires sqlite-vec when the backend
   *  lands (separate slice). */
  store?: MemoryStore;
}

export interface MemoryServerHandle {
  /** Reference to the underlying store — exposed so tests can inspect
   *  state without poking through the HTTP surface. Production callers
   *  shouldn't need this; they go through the API. */
  store: MemoryStore;
  stop(): Promise<void>;
}

const STARTED_AT = Date.now();

export async function startMemoryServer(opts: MemoryServerOptions): Promise<MemoryServerHandle> {
  await mkdir(dirname(opts.socketPath), { recursive: true, mode: 0o700 });
  await unlink(opts.socketPath).catch(() => {});

  const store = opts.store ?? new InMemoryMemoryStore();
  const server = createServer((req, res) => route(req, res, store));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socketPath, () => resolve());
  });

  await chmod(opts.socketPath, 0o600);

  return {
    store,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(opts.socketPath).catch(() => {});
    },
  };
}

function route(req: IncomingMessage, res: ServerResponse, store: MemoryStore): void {
  const url = (req.url ?? '/').split('?')[0]!.replace(/\/$/, '') || '/';

  // GET /health — backend state + size for diagnostic dashboards.
  if (req.method === 'GET' && url === '/health') {
    handleHealth(res, store).catch((err: Error) => serverError(res, err.message));
    return;
  }

  // POST /v1/memory/put — body { key, value, scope? }
  if (req.method === 'POST' && url === '/v1/memory/put') {
    consumeJsonBody(req, (parsed, err) => {
      if (err) {
        badRequest(res, err);
        return;
      }
      handlePut(res, store, parsed).catch((e: Error) => serverError(res, e.message));
    });
    return;
  }

  // POST /v1/memory/query — body MemoryQuery (discriminated union by `kind`)
  if (req.method === 'POST' && url === '/v1/memory/query') {
    consumeJsonBody(req, (parsed, err) => {
      if (err) {
        badRequest(res, err);
        return;
      }
      handleQuery(res, store, parsed).catch((e: Error) => serverError(res, e.message));
    });
    return;
  }

  // Fallback echo for unknown paths — preserves v0 contract for early
  // bringup checks and tests that haven't migrated yet.
  echo(req, res, 'memory');
}

async function handleHealth(res: ServerResponse, store: MemoryStore): Promise<void> {
  const size = await store.size();
  ok(res, {
    service: 'memory',
    state: 'warm',
    uptimeMs: Date.now() - STARTED_AT,
    backend: store.constructor.name,
    entryCount: size,
    ts: new Date().toISOString(),
  });
}

async function handlePut(res: ServerResponse, store: MemoryStore, body: unknown): Promise<void> {
  if (!isObject(body)) {
    badRequest(res, 'body must be a JSON object');
    return;
  }
  const key = (body as { key?: unknown }).key;
  const value = (body as { value?: unknown }).value;
  if (typeof key !== 'string' || key.length === 0) {
    badRequest(res, 'body.key is required (non-empty string)');
    return;
  }
  if (value === undefined) {
    badRequest(res, 'body.value is required');
    return;
  }
  const input: MemoryPutInput = {
    key,
    value,
    ...(isScope((body as { scope?: unknown }).scope)
      ? { scope: (body as { scope: MemoryScope }).scope }
      : {}),
  };
  const entry = await store.put(input);
  ok(res, {
    service: 'memory',
    method: 'POST',
    path: '/v1/memory/put',
    entry,
    ts: new Date().toISOString(),
  });
}

async function handleQuery(res: ServerResponse, store: MemoryStore, body: unknown): Promise<void> {
  if (!isObject(body)) {
    badRequest(res, 'body must be a JSON MemoryQuery object');
    return;
  }
  const kind = (body as { kind?: unknown }).kind;
  if (kind !== 'structured' && kind !== 'recent' && kind !== 'similarity' && kind !== 'graph') {
    badRequest(
      res,
      `body.kind must be one of: structured, recent, similarity, graph (got: ${String(kind)})`,
    );
    return;
  }
  const query = body as MemoryQuery;
  const result = await store.query(query);
  ok(res, {
    service: 'memory',
    method: 'POST',
    path: '/v1/memory/query',
    result,
    ts: new Date().toISOString(),
  });
}

function consumeJsonBody(
  req: IncomingMessage,
  cb: (parsed: unknown, err: string | null) => void,
): void {
  let body = '';
  req.on('data', (c) => (body += c.toString()));
  req.on('end', () => {
    if (body.length === 0) {
      cb({}, null);
      return;
    }
    try {
      cb(JSON.parse(body), null);
    } catch (err) {
      cb(null, `invalid JSON: ${(err as Error).message}`);
    }
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Loose check that `value` looks like a MemoryScope object. Unknown
 *  fields are tolerated (forward-compat for new scope keys); known
 *  fields must be strings when present. */
function isScope(value: unknown): value is MemoryScope {
  if (!isObject(value)) return false;
  const keys = ['jobId', 'productId', 'userId', 'sessionId', 'organizationId', 'topic'];
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (v !== undefined && typeof v !== 'string') return false;
  }
  return true;
}

function echo(req: IncomingMessage, res: ServerResponse, service: string): void {
  let body = '';
  req.on('data', (c) => (body += c.toString()));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service,
        method: req.method,
        path: req.url,
        body: body ? safeJson(body) : null,
        ts: new Date().toISOString(),
      }),
    );
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

export {
  InMemoryMemoryStore,
  type MemoryEntry,
  type MemoryPutInput,
  type MemoryQuery,
  type MemoryQueryResult,
  type MemoryScope,
  type MemoryStore,
} from './store.ts';

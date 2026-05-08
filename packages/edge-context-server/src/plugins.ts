/**
 * Plugin framework (PRD F14–F16 / CS-8).
 *
 * Plugins extend the server with non-GraphRAG `ContextProvider`
 * capabilities — OpenAPI lookup, third-party catalog adapters, future
 * search backends. Each plugin:
 *
 *   - declares an `id` (used in route prefix /v1/plugins/<id>/...)
 *   - implements `register(ctx)` to mount its routes
 *   - optionally exposes `dispose()` for cleanup on server stop
 *
 * The server collects plugins at startup via `ContextServerOptions.plugins`
 * and dispatches `/v1/plugins/<id>/*` requests to them. Plugins receive
 * a `PluginContext` that gives them access to the embedder config,
 * Neo4j credentials, and a typed event emitter. They DON'T get the
 * full QueryService — by design, plugins are sidekicks, not co-equal
 * engines.
 *
 * Reference impl: `OpenApiPlugin` (below) — fetches an OpenAPI spec,
 * indexes operations as Endpoint nodes in the graph, exposes
 * `openapi.lookup` (find an operation by api+operation id) and
 * `openapi.operations` (list all operations of an api).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EmbedderConfig } from '@ecruz165/context-loader-core';
import { Neo4jBackend } from '@ecruz165/context-loader-core';
import neo4j, { type Driver } from 'neo4j-driver';

export interface PluginRouteHandler {
  (req: IncomingMessage, res: ServerResponse, sub: string): void | Promise<void>;
}

export interface PluginContext {
  /** Plugin id — for diagnostics + log lines. */
  pluginId: string;
  /** Embedder config the host server is using; plugins are encouraged
   *  to share the embedding space rather than introduce new ones. */
  embedderConfig: EmbedderConfig;
  /** Bolt URL + creds for a plugin to write Doc / Endpoint / etc.
   *  nodes. Plugins should construct their own Neo4jBackend if they
   *  need bulk writes. */
  neo4j: { url: string; user: string; password: string; database: string };
}

export interface Plugin {
  /** Stable id, lowercase, used in URL prefix /v1/plugins/<id>/*. */
  id: string;
  /** One-line description — rendered in `edge-context plugins list`. */
  description: string;
  /** Called once at server startup. The plugin returns its route
   *  handler; the server dispatches every request matching
   *  /v1/plugins/<id>/<sub> by calling `handler(req, res, sub)`. */
  register(ctx: PluginContext): PluginRouteHandler | Promise<PluginRouteHandler>;
  /** Optional cleanup. Called at server stop. */
  dispose?(): void | Promise<void>;
}

export interface RegisteredPlugin {
  plugin: Plugin;
  handler: PluginRouteHandler;
}

// ─── Reference impl: OpenAPI plugin ────────────────────────────────

export interface OpenApiPluginOptions {
  /** Per-API specs to index. Each entry maps an alias to a spec
   *  source (URL or file path). v1 supports JSON only; YAML support
   *  would add a yaml dep — deferred. */
  specs: Array<{ alias: string; url?: string; file?: string }>;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

interface IndexedOperation {
  api: string;
  operationId: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  tags?: string[];
}

/**
 * Reference plugin: indexes OpenAPI specs into the graph as Endpoint
 * nodes and exposes lookup operations over the plugin route prefix.
 *
 * Routes (all under /v1/plugins/openapi/...):
 *   POST  /lookup       body { api, operation } → operation details
 *   POST  /operations   body { api } → list of operations
 *   GET   /apis         list registered API aliases
 *   POST  /reindex      re-fetch + re-index all specs
 */
export class OpenApiPlugin implements Plugin {
  readonly id = 'openapi';
  readonly description = 'OpenAPI spec indexer + operation lookup';
  private operations: Map<string, IndexedOperation[]> = new Map();
  private readonly fetchImpl: typeof fetch;
  private indexed = false;

  constructor(private readonly opts: OpenApiPluginOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async register(ctx: PluginContext): Promise<PluginRouteHandler> {
    // Index specs at registration. Failures don't crash the server —
    // they're surfaced when the operator hits /v1/plugins/openapi/apis
    // and sees an empty list, or when /lookup returns "api not found".
    await this.reindex(ctx).catch(() => {
      this.indexed = false;
    });

    return async (req, res, sub) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && (sub === 'apis' || sub === '')) {
        return jsonOk(res, {
          apis: [...this.operations.entries()].map(([alias, ops]) => ({
            alias,
            operationCount: ops.length,
          })),
          indexed: this.indexed,
        });
      }
      if (req.method === 'POST' && sub === 'lookup') {
        const body = await readJsonBody(req);
        const api = (body as { api?: unknown }).api;
        const operation = (body as { operation?: unknown }).operation;
        if (typeof api !== 'string' || typeof operation !== 'string') {
          return jsonBad(res, 'body must include string `api` and string `operation`');
        }
        const ops = this.operations.get(api);
        if (!ops) return jsonNotFound(res, `api '${api}' not found`);
        const op = ops.find((o) => o.operationId === operation);
        if (!op) return jsonNotFound(res, `operation '${operation}' not in api '${api}'`);
        return jsonOk(res, { result: op });
      }
      if (req.method === 'POST' && sub === 'operations') {
        const body = await readJsonBody(req);
        const api = (body as { api?: unknown }).api;
        if (typeof api !== 'string') return jsonBad(res, 'body must include string `api`');
        const ops = this.operations.get(api);
        if (!ops) return jsonNotFound(res, `api '${api}' not found`);
        return jsonOk(res, { api, operations: ops });
      }
      if (req.method === 'POST' && sub === 'reindex') {
        try {
          await this.reindex(ctx);
          return jsonOk(res, { reindexed: true, apis: this.operations.size });
        } catch (err) {
          return jsonError(res, (err as Error).message);
        }
      }
      jsonNotFound(res, `unknown openapi plugin route: ${url}`);
    };
  }

  /** Fetch + parse + index every configured spec. Idempotent. */
  async reindex(ctx: PluginContext): Promise<void> {
    this.operations.clear();

    // Build a Neo4j driver lazily — only if we'll actually write nodes.
    let driver: Driver | null = null;
    let backend: Neo4jBackend | null = null;
    try {
      for (const spec of this.opts.specs) {
        const text = await this.loadSpec(spec);
        const ops = parseOpenApi(text, spec.alias);
        this.operations.set(spec.alias, ops);

        // Lazy backend init on first spec
        if (!backend) {
          driver = neo4j.driver(
            ctx.neo4j.url,
            neo4j.auth.basic(ctx.neo4j.user, ctx.neo4j.password),
          );
          backend = new Neo4jBackend({
            url: ctx.neo4j.url,
            user: ctx.neo4j.user,
            password: ctx.neo4j.password,
            database: ctx.neo4j.database,
            vectorDim: ctx.embedderConfig.dim,
          });
          await backend.ensureSchema({ nodes: ['Endpoint'], edges: [] });
        }

        // Write Endpoint nodes for each operation. No embedding in v1
        // — operations are typically small + searched by id, not by
        // similarity. Adding embeddings is a follow-up.
        await backend.upsertNodesBulk(
          ops.map((o) => ({
            id: `openapi:${spec.alias}:${o.operationId}`,
            label: 'Endpoint',
            properties: {
              api: o.api,
              operationId: o.operationId,
              method: o.method,
              path: o.path,
              summary: o.summary ?? '',
              description: o.description ?? '',
              tags: (o.tags ?? []).join(','),
            },
            sourceTypeId: 'openapi',
            sourceId: spec.alias,
          })),
        );
      }
      this.indexed = true;
    } finally {
      if (backend) await backend.close();
      if (driver) await driver.close();
    }
  }

  private async loadSpec(spec: { url?: string; file?: string }): Promise<string> {
    if (spec.url) {
      const r = await this.fetchImpl(spec.url);
      if (r.status >= 400) throw new Error(`failed to fetch ${spec.url}: HTTP ${r.status}`);
      return await r.text();
    }
    if (spec.file) {
      const { readFile } = await import('node:fs/promises');
      return await readFile(spec.file, 'utf8');
    }
    throw new Error('OpenAPI spec entry must have `url` or `file`');
  }
}

/** Minimal OpenAPI 3.x parser — extracts operations into a flat list.
 *  Doesn't validate the spec; doesn't expand $refs. v1 is "good enough
 *  for lookup by id and listing by api"; full validation is out of scope. */
function parseOpenApi(text: string, api: string): IndexedOperation[] {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`OpenAPI spec is not valid JSON: ${(err as Error).message}`);
  }
  const paths = (doc.paths ?? {}) as Record<string, unknown>;
  const ops: IndexedOperation[] = [];
  const methods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'trace'];
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const item = pathItem as Record<string, unknown>;
    for (const method of methods) {
      const op = item[method];
      if (!op || typeof op !== 'object') continue;
      const o = op as {
        operationId?: string;
        summary?: string;
        description?: string;
        tags?: string[];
      };
      ops.push({
        api,
        operationId: o.operationId ?? `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        summary: o.summary,
        description: o.description,
        tags: o.tags,
      });
    }
  }
  return ops;
}

// ─── Plugin route helpers ───────────────────────────────────────────

function jsonOk(res: ServerResponse, payload: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, ...payload }));
}

function jsonBad(res: ServerResponse, error: string): void {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error }));
}

function jsonNotFound(res: ServerResponse, error: string): void {
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error }));
}

function jsonError(res: ServerResponse, error: string): void {
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error }));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c: Buffer) => (buf += c.toString()));
    req.on('end', () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export const __test__ = { parseOpenApi };

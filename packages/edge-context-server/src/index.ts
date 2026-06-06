import { chmod, mkdir, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { dirname } from 'node:path';
import { WebSocketServer } from 'ws';
import type {
  CrawlIngestRequest,
  IngestService,
  RepoIngestRequest,
  UploadIngestRequest,
} from './ingest.ts';
import type {
  ConfluenceIngestRequest,
  GithubIssuesIngestRequest,
  JiraIngestRequest,
} from './external-sources.ts';
import type { Plugin, PluginContext, RegisteredPlugin } from './plugins.ts';
import { CronScheduler, type ScheduledJob } from './cron.ts';
import { OPENAPI_SPEC } from './openapi.ts';
import type {
  ContextQueryRequest,
  CypherRequest,
  QueryService,
  RelatedRequest,
  TraverseRequest,
} from './query.ts';

export interface ContextServerOptions {
  socketPath: string;
  /** When provided, /v1/context/query + /v1/stats route to real backend.
   *  When absent, /v1/context/query falls back to echo behavior, /v1/stats
   *  reports zero counts, /health reports state='no-backend'. Tests can
   *  inject a stub QueryService to exercise the route surface without a
   *  live Neo4j. */
  query?: QueryService;
  /** Wires the four intake paths (repo/upload/crawl/external). When
   *  absent, ingest routes return 503 — analogous to the query side. */
  ingest?: IngestService;
  /** Idle-throttling threshold in ms. After this much time without any
   *  request, the QueryService is closed (releases Neo4j sessions +
   *  embedding state). PRD F11 lean: 10min. Set to 0 to disable. */
  idleThrottleMs?: number;
  /** Hook called when the server idle-throttles, exposed for tests. */
  onIdleThrottle?: () => void;
  /** Plugins (PRD F14–F16). Each plugin's routes are mounted under
   *  /v1/plugins/<plugin.id>/*. Plugins are registered at server start
   *  in array order; if a plugin's register() throws, the server still
   *  starts but that plugin's routes 503. */
  plugins?: Plugin[];
  /** Optional plugin context override — tests use this to inject a
   *  fake Neo4j config without needing a real server. */
  pluginContext?: Partial<PluginContext>;
  /** Cron-scheduled jobs (PRD F7). Each job fires its callback on
   *  the cron expression's schedule. v1 is in-process — restarts
   *  reset job timing. Persistence + distributed coordination land
   *  in v1.x. */
  schedule?: ScheduledJob[];
}

const DEFAULT_IDLE_MS = 10 * 60 * 1000; // F11

interface MetricsCounters {
  requests: number;
  requestsByRoute: Record<string, number>;
  errors: number;
  startedAt: number;
  lastRequestAt: number;
  ingestsStarted: number;
  wsConnects: number;
  idleThrottles: number;
}

const STARTED_AT = Date.now();

export interface ContextServerHandle {
  /** Cron scheduler — operators can `add()` / `remove()` jobs at runtime. */
  cron: CronScheduler;
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

  const metrics: MetricsCounters = {
    requests: 0,
    requestsByRoute: {},
    errors: 0,
    startedAt: STARTED_AT,
    lastRequestAt: STARTED_AT,
    ingestsStarted: 0,
    wsConnects: 0,
    idleThrottles: 0,
  };
  // Register plugins. Each plugin's register() may throw; we capture
  // failures and let the route surface return 503 for the affected
  // plugin without taking the whole server down.
  const registered: RegisteredPlugin[] = [];
  if (opts.plugins) {
    const pctx: PluginContext = {
      pluginId: '',
      embedderConfig: opts.pluginContext?.embedderConfig ?? {
        url: '',
        model: '',
        dim: 0,
      },
      neo4j: opts.pluginContext?.neo4j ?? {
        url: '',
        user: 'neo4j',
        password: '',
        database: 'neo4j',
      },
    };
    for (const plugin of opts.plugins) {
      try {
        const handler = await plugin.register({ ...pctx, pluginId: plugin.id });
        registered.push({ plugin, handler });
      } catch (err) {
        // Plugin failed to register — log and skip. Route surface
        // will 503 for this plugin's id.
        // (We don't have a structured logger yet; stderr is the v1 sink.)
        process.stderr.write(
          `[edge-context-server] plugin '${plugin.id}' failed to register: ${(err as Error).message}\n`,
        );
      }
    }
  }

  const ctx: RouteContext = { opts, metrics, plugins: registered };

  const server = createServer((req, res) => {
    metrics.requests += 1;
    metrics.lastRequestAt = Date.now();
    route(req, res, ctx);
  });

  // WebSocket upgrade — /v1/ingest/events streams ingestion events.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket: Duplex, head) => {
    const url = (req.url ?? '').split('?')[0]?.replace(/\/$/, '') ?? '';
    if (url !== '/v1/ingest/events') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      metrics.wsConnects += 1;
      attachWsClient(ws, req, opts.ingest);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socketPath, () => resolve());
  });

  await chmod(opts.socketPath, 0o600);

  // Cron scheduler (F7). Constructed even when `schedule` is empty —
  // operators can add jobs at runtime via the returned handle.
  const cron = new CronScheduler();
  if (opts.schedule) {
    for (const job of opts.schedule) cron.add(job);
  }
  cron.start();

  // Idle throttle: poll every 60s; if lastRequestAt is older than
  // idleThrottleMs, call query.close() to release Neo4j sessions. The
  // service is recreated on next request via the test's harness; in
  // production deployments the operator restarts the server (or wires
  // a re-init hook in v1.x). v1 = clean shutdown of Neo4j only.
  const idleMs = opts.idleThrottleMs ?? DEFAULT_IDLE_MS;
  let idleTimer: NodeJS.Timeout | null = null;
  let throttled = false;
  if (idleMs > 0) {
    const tick = async () => {
      if (throttled) return;
      const idleFor = Date.now() - metrics.lastRequestAt;
      if (idleFor >= idleMs && opts.query) {
        throttled = true;
        metrics.idleThrottles += 1;
        await opts.query.close().catch(() => {});
        opts.onIdleThrottle?.();
      }
    };
    idleTimer = setInterval(tick, Math.min(60_000, idleMs));
  }

  return {
    cron,
    async stop() {
      cron.stop();
      if (idleTimer) clearInterval(idleTimer);
      // Close WS connections before tearing down HTTP.
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(opts.socketPath).catch(() => {});
      await opts.query?.close().catch(() => {});
      await opts.ingest?.close().catch(() => {});
      // Dispose plugins last — they may need the server alive while
      // they shut down (e.g., Neo4j writes during tear-down).
      for (const rp of registered) {
        if (rp.plugin.dispose) {
          await Promise.resolve(rp.plugin.dispose()).catch(() => {});
        }
      }
    },
  };
}

interface RouteContext {
  opts: ContextServerOptions;
  metrics: MetricsCounters;
  plugins: RegisteredPlugin[];
}

function bumpRoute(metrics: MetricsCounters, key: string): void {
  metrics.requestsByRoute[key] = (metrics.requestsByRoute[key] ?? 0) + 1;
}

function route(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): void {
  const opts = ctx.opts;
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
          domains: Array.isArray(reqBody.domains)
            ? reqBody.domains.filter((d): d is string => typeof d === 'string')
            : undefined,
          mode: typeof reqBody.mode === 'string' ? reqBody.mode : undefined,
          expandDepth: typeof reqBody.expandDepth === 'number' ? reqBody.expandDepth : undefined,
          expandPredicates: Array.isArray(reqBody.expandPredicates)
            ? reqBody.expandPredicates.filter((p): p is string => typeof p === 'string')
            : undefined,
          vectorWeight: typeof reqBody.vectorWeight === 'number' ? reqBody.vectorWeight : undefined,
          bm25Weight: typeof reqBody.bm25Weight === 'number' ? reqBody.bm25Weight : undefined,
          graphWeight: typeof reqBody.graphWeight === 'number' ? reqBody.graphWeight : undefined,
          hubDegreeCeiling:
            typeof reqBody.hubDegreeCeiling === 'number' ? reqBody.hubDegreeCeiling : undefined,
          expandPredicateWeights:
            reqBody.expandPredicateWeights &&
            typeof reqBody.expandPredicateWeights === 'object' &&
            !Array.isArray(reqBody.expandPredicateWeights)
              ? (reqBody.expandPredicateWeights as Record<string, number>)
              : undefined,
          hubDampening: typeof reqBody.hubDampening === 'boolean' ? reqBody.hubDampening : undefined,
          maxNeighborsPerSeed:
            typeof reqBody.maxNeighborsPerSeed === 'number' ? reqBody.maxNeighborsPerSeed : undefined,
        });
        ok(res, { service: 'context', result, ts: new Date().toISOString() });
      } catch (err) {
        serverError(res, (err as Error).message);
      }
    });
    return;
  }

  // POST /v1/traverse — depth-bounded subgraph from a seed entity.
  // body: { entity, depth, predicates?, productId?, limit? }
  if (req.method === 'POST' && url === '/v1/traverse') {
    handleJsonPost<TraverseRequest>(req, res, opts.query, async (q, body) => {
      if (!body || typeof body.entity !== 'string') {
        return badRequest(res, 'body must include string `entity`');
      }
      if (typeof body.depth !== 'number') {
        return badRequest(res, 'body must include numeric `depth`');
      }
      const result = await q.traverse({
        entity: body.entity,
        depth: body.depth,
        predicates: Array.isArray(body.predicates)
          ? body.predicates.filter((p): p is string => typeof p === 'string')
          : undefined,
        productId: typeof body.productId === 'string' ? body.productId : undefined,
        limit: typeof body.limit === 'number' ? body.limit : undefined,
      });
      ok(res, { service: 'context', result, ts: new Date().toISOString() });
    });
    return;
  }

  // POST /v1/related — single-predicate adjacency from a seed entity.
  // body: { entity, predicate, depth, productId?, limit? }
  if (req.method === 'POST' && url === '/v1/related') {
    handleJsonPost<RelatedRequest>(req, res, opts.query, async (q, body) => {
      if (!body || typeof body.entity !== 'string') {
        return badRequest(res, 'body must include string `entity`');
      }
      if (typeof body.predicate !== 'string') {
        return badRequest(res, 'body must include string `predicate`');
      }
      if (typeof body.depth !== 'number') {
        return badRequest(res, 'body must include numeric `depth`');
      }
      const result = await q.related({
        entity: body.entity,
        predicate: body.predicate,
        depth: body.depth,
        productId: typeof body.productId === 'string' ? body.productId : undefined,
        limit: typeof body.limit === 'number' ? body.limit : undefined,
      });
      ok(res, { service: 'context', result, ts: new Date().toISOString() });
    });
    return;
  }

  // POST /v1/query — admin Cypher passthrough. Per § 4.2 F31 this is
  // gated to UDS-only; v1 is UDS-only structurally so the gate is the
  // listener, not a header check. The READ access mode in the
  // QueryService prevents writes regardless of the cypher string.
  // body: { cypher, params?, limit? }
  if (req.method === 'POST' && url === '/v1/query') {
    handleJsonPost<CypherRequest>(req, res, opts.query, async (q, body) => {
      if (!body || typeof body.cypher !== 'string') {
        return badRequest(res, 'body must include string `cypher`');
      }
      const result = await q.cypher({
        cypher: body.cypher,
        params:
          body.params && typeof body.params === 'object'
            ? (body.params as Record<string, unknown>)
            : undefined,
        limit: typeof body.limit === 'number' ? body.limit : undefined,
      });
      ok(res, { service: 'context', result, ts: new Date().toISOString() });
    });
    return;
  }

  // GET /openapi.json — minimal hand-curated OpenAPI 3.1 spec (F20).
  if (req.method === 'GET' && url === '/openapi.json') {
    bumpRoute(ctx.metrics, 'openapi');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(OPENAPI_SPEC));
    return;
  }

  // GET /metrics — Prometheus-style text exposition. Tiny v1 shape; full
  // Prom client integration deferred to v1.x.
  if (req.method === 'GET' && url === '/metrics') {
    bumpRoute(ctx.metrics, 'metrics');
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(formatMetrics(ctx.metrics));
    return;
  }

  // POST /v1/ingest/repo — body { name, source, sourceTypeId?, productId? }
  // Returns 202 + ingestId; ingest runs in the background.
  if (req.method === 'POST' && url === '/v1/ingest/repo') {
    bumpRoute(ctx.metrics, 'ingest_repo');
    handleJsonPostIngest<RepoIngestRequest>(req, res, opts.ingest, async (svc, body) => {
      if (!body || typeof body.name !== 'string') {
        return badRequest(res, 'body must include string `name`');
      }
      if (!body.source || typeof body.source !== 'object') {
        return badRequest(res, 'body must include object `source`');
      }
      const src = body.source as { type?: unknown; path?: unknown; cloneUrl?: unknown; branch?: unknown };
      if (src.type !== 'local' && src.type !== 'git') {
        return badRequest(res, `source.type must be 'local' or 'git' (got ${String(src.type)})`);
      }
      if (src.type === 'local' && typeof src.path !== 'string') {
        return badRequest(res, 'source.path must be a string for local source');
      }
      if (src.type === 'git' && typeof src.cloneUrl !== 'string') {
        return badRequest(res, 'source.cloneUrl must be a string for git source');
      }
      const validatedSrc =
        src.type === 'local'
          ? { type: 'local' as const, path: src.path as string }
          : {
              type: 'git' as const,
              cloneUrl: src.cloneUrl as string,
              branch: typeof src.branch === 'string' ? src.branch : undefined,
            };
      const result = await svc.startRepoIngest({
        name: body.name,
        source: validatedSrc,
        sourceTypeId: typeof body.sourceTypeId === 'string' ? body.sourceTypeId : undefined,
        productId: typeof body.productId === 'string' ? body.productId : undefined,
      });
      ctx.metrics.ingestsStarted += 1;
      accepted(res, { service: 'context', ingestId: result.ingestId, ts: new Date().toISOString() });
    });
    return;
  }

  // POST /v1/ingest/github-issues — body { name, repo, labels?, state?, since?, productId?, maxPages? }
  // Reads GITHUB_TOKEN from server env (CredentialBroker integration deferred).
  if (req.method === 'POST' && url === '/v1/ingest/github-issues') {
    bumpRoute(ctx.metrics, 'ingest_github_issues');
    handleJsonPostIngest<GithubIssuesIngestRequest>(req, res, opts.ingest, async (svc, body) => {
      if (!body || typeof body.name !== 'string') {
        return badRequest(res, 'body must include string `name`');
      }
      if (typeof body.repo !== 'string') {
        return badRequest(res, "body must include string `repo` (e.g., 'org/name')");
      }
      const result = await svc.startGithubIssuesIngest({
        name: body.name,
        repo: body.repo,
        labels: Array.isArray(body.labels)
          ? body.labels.filter((l): l is string => typeof l === 'string')
          : undefined,
        state:
          body.state === 'open' || body.state === 'closed' || body.state === 'all'
            ? body.state
            : undefined,
        since: typeof body.since === 'string' ? body.since : undefined,
        maxPages: typeof body.maxPages === 'number' ? body.maxPages : undefined,
        productId: typeof body.productId === 'string' ? body.productId : undefined,
      });
      ctx.metrics.ingestsStarted += 1;
      accepted(res, { service: 'context', ingestId: result.ingestId, ts: new Date().toISOString() });
    });
    return;
  }

  // POST /v1/ingest/jira — body { name, jql, maxResults?, fields?, productId? }
  // Reads JIRA_TOKEN, JIRA_BASE_URL, JIRA_EMAIL from server env.
  if (req.method === 'POST' && url === '/v1/ingest/jira') {
    bumpRoute(ctx.metrics, 'ingest_jira');
    handleJsonPostIngest<JiraIngestRequest>(req, res, opts.ingest, async (svc, body) => {
      if (!body || typeof body.name !== 'string') {
        return badRequest(res, 'body must include string `name`');
      }
      if (typeof body.jql !== 'string' || body.jql.length === 0) {
        return badRequest(res, 'body must include non-empty string `jql`');
      }
      const result = await svc.startJiraIngest({
        name: body.name,
        jql: body.jql,
        maxResults: typeof body.maxResults === 'number' ? body.maxResults : undefined,
        fields: Array.isArray(body.fields)
          ? body.fields.filter((f): f is string => typeof f === 'string')
          : undefined,
        productId: typeof body.productId === 'string' ? body.productId : undefined,
      });
      ctx.metrics.ingestsStarted += 1;
      accepted(res, { service: 'context', ingestId: result.ingestId, ts: new Date().toISOString() });
    });
    return;
  }

  // POST /v1/ingest/confluence — body { name, space, maxResults?, productId? }
  // Reads CONFLUENCE_TOKEN, CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL from server env.
  if (req.method === 'POST' && url === '/v1/ingest/confluence') {
    bumpRoute(ctx.metrics, 'ingest_confluence');
    handleJsonPostIngest<ConfluenceIngestRequest>(req, res, opts.ingest, async (svc, body) => {
      if (!body || typeof body.name !== 'string') {
        return badRequest(res, 'body must include string `name`');
      }
      if (typeof body.space !== 'string' || body.space.length === 0) {
        return badRequest(res, 'body must include non-empty string `space` (Confluence space key)');
      }
      const result = await svc.startConfluenceIngest({
        name: body.name,
        space: body.space,
        maxResults: typeof body.maxResults === 'number' ? body.maxResults : undefined,
        productId: typeof body.productId === 'string' ? body.productId : undefined,
      });
      ctx.metrics.ingestsStarted += 1;
      accepted(res, { service: 'context', ingestId: result.ingestId, ts: new Date().toISOString() });
    });
    return;
  }

  // POST /v1/ingest/crawl — body { name, url, productId?, rateLimitPerHost?,
  //                                 ifNoneMatch?, ifModifiedSince? }
  // v1 supports scope:'page' only (single URL fetch + readability).
  if (req.method === 'POST' && url === '/v1/ingest/crawl') {
    bumpRoute(ctx.metrics, 'ingest_crawl');
    handleJsonPostIngest<CrawlIngestRequest>(req, res, opts.ingest, async (svc, body) => {
      if (!body || typeof body.name !== 'string') {
        return badRequest(res, 'body must include string `name`');
      }
      if (typeof body.url !== 'string') {
        return badRequest(res, 'body must include string `url`');
      }
      const scope =
        body.scope === 'page' || body.scope === 'subtree' || body.scope === 'site'
          ? body.scope
          : undefined;
      const result = await svc.startCrawlIngest({
        name: body.name,
        url: body.url,
        scope,
        maxDepth: typeof body.maxDepth === 'number' ? body.maxDepth : undefined,
        maxPages: typeof body.maxPages === 'number' ? body.maxPages : undefined,
        allowedDomains: Array.isArray(body.allowedDomains)
          ? body.allowedDomains.filter((d): d is string => typeof d === 'string')
          : undefined,
        productId: typeof body.productId === 'string' ? body.productId : undefined,
        rateLimitPerHost:
          typeof body.rateLimitPerHost === 'number' ? body.rateLimitPerHost : undefined,
        ifNoneMatch: typeof body.ifNoneMatch === 'string' ? body.ifNoneMatch : undefined,
        ifModifiedSince:
          typeof body.ifModifiedSince === 'string' ? body.ifModifiedSince : undefined,
      });
      ctx.metrics.ingestsStarted += 1;
      accepted(res, { service: 'context', ingestId: result.ingestId, ts: new Date().toISOString() });
    });
    return;
  }

  // POST /v1/ingest/upload — multipart/form-data with `file` part + JSON
  // metadata. Body is parsed below.
  if (req.method === 'POST' && url === '/v1/ingest/upload') {
    bumpRoute(ctx.metrics, 'ingest_upload');
    if (!opts.ingest) {
      return notReady(res, 'backend not configured');
    }
    handleMultipartUpload(req, res, opts.ingest, ctx.metrics);
    return;
  }

  // GET /v1/ingest/<ingestId> — status of an ingest run.
  if (req.method === 'GET' && url.startsWith('/v1/ingest/') && url !== '/v1/ingest/events') {
    bumpRoute(ctx.metrics, 'ingest_status');
    const ingestId = url.slice('/v1/ingest/'.length);
    if (!opts.ingest) return notReady(res, 'backend not configured');
    const status = opts.ingest.getIngest(ingestId);
    if (!status) return notFound(res, `ingest not found: ${ingestId}`);
    ok(res, { service: 'context', status, ts: new Date().toISOString() });
    return;
  }

  // GET /v1/ingest — list all ingests.
  if (req.method === 'GET' && url === '/v1/ingest') {
    bumpRoute(ctx.metrics, 'ingest_list');
    if (!opts.ingest) return notReady(res, 'backend not configured');
    ok(res, { service: 'context', ingests: opts.ingest.listIngests(), ts: new Date().toISOString() });
    return;
  }

  // DELETE /v1/ingest/<ingestId> — cancel an in-flight ingest.
  if (req.method === 'DELETE' && url.startsWith('/v1/ingest/')) {
    bumpRoute(ctx.metrics, 'ingest_cancel');
    const ingestId = url.slice('/v1/ingest/'.length);
    if (!opts.ingest) return notReady(res, 'backend not configured');
    const cancelled = opts.ingest.cancelIngest(ingestId);
    if (!cancelled) return notFound(res, `ingest not found: ${ingestId}`);
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /v1/uploads — list stored uploads.
  if (req.method === 'GET' && url === '/v1/uploads') {
    bumpRoute(ctx.metrics, 'uploads_list');
    if (!opts.ingest) return notReady(res, 'backend not configured');
    void opts.ingest
      .listUploads()
      .then((entries) => ok(res, { service: 'context', uploads: entries, ts: new Date().toISOString() }))
      .catch((err: Error) => serverError(res, err.message));
    return;
  }

  // DELETE /v1/uploads/<docId> — remove file + graph node.
  if (req.method === 'DELETE' && url.startsWith('/v1/uploads/')) {
    bumpRoute(ctx.metrics, 'uploads_delete');
    const docId = url.slice('/v1/uploads/'.length);
    if (!opts.ingest) return notReady(res, 'backend not configured');
    void opts.ingest
      .deleteUpload(docId)
      .then((existed) => {
        if (!existed) return notFound(res, `upload not found: ${docId}`);
        res.writeHead(204);
        res.end();
      })
      .catch((err: Error) => serverError(res, err.message));
    return;
  }

  // GET /v1/plugins — list registered plugins (PRD F14).
  if (req.method === 'GET' && url === '/v1/plugins') {
    bumpRoute(ctx.metrics, 'plugins_list');
    ok(res, {
      service: 'context',
      plugins: ctx.plugins.map((rp) => ({ id: rp.plugin.id, description: rp.plugin.description })),
      ts: new Date().toISOString(),
    });
    return;
  }

  // /v1/plugins/<id>/<sub> — dispatch to the registered plugin (F14–F16).
  if (url.startsWith('/v1/plugins/')) {
    const rest = url.slice('/v1/plugins/'.length);
    const slash = rest.indexOf('/');
    const pluginId = slash >= 0 ? rest.slice(0, slash) : rest;
    const sub = slash >= 0 ? rest.slice(slash + 1) : '';
    bumpRoute(ctx.metrics, `plugin_${pluginId}`);
    const rp = ctx.plugins.find((p) => p.plugin.id === pluginId);
    if (!rp) {
      return notFound(res, `plugin '${pluginId}' not registered`);
    }
    void Promise.resolve()
      .then(() => rp.handler(req, res, sub))
      .catch((err: Error) => {
        if (!res.headersSent) serverError(res, err.message);
      });
    return;
  }

  // Fallback echo for any unknown path — useful for early bringup checks.
  echo(req, res, 'context');
}

/**
 * Shared body-collect + dispatch for POST routes that need a wired
 * QueryService. Routes that should still respond when no backend is
 * configured (e.g. /v1/context/query's echo path) handle that themselves;
 * the new graphrag.* routes treat "no backend" as a hard 503 because
 * they have no meaningful echo behavior.
 */
function handleJsonPost<TBody>(
  req: IncomingMessage,
  res: ServerResponse,
  query: QueryService | undefined,
  handler: (q: QueryService, body: Partial<TBody> | null) => Promise<void>,
): void {
  if (!query) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'backend not configured' }));
    return;
  }
  let raw = '';
  req.on('data', (c) => (raw += c.toString()));
  req.on('end', async () => {
    const parsed = raw ? safeJson(raw) : null;
    try {
      await handler(query, parsed as Partial<TBody> | null);
    } catch (err) {
      serverError(res, (err as Error).message);
    }
  });
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

function accepted(res: ServerResponse, payload: Record<string, unknown>): void {
  res.writeHead(202, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, ...payload }));
}

function badRequest(res: ServerResponse, error: string): void {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error }));
}

function notFound(res: ServerResponse, error: string): void {
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error }));
}

function notReady(res: ServerResponse, error: string): void {
  res.writeHead(503, { 'content-type': 'application/json' });
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

/** Same shape as handleJsonPost but for ingest routes. Diverges only
 *  in the 503-when-no-ingest-service branch. */
function handleJsonPostIngest<TBody>(
  req: IncomingMessage,
  res: ServerResponse,
  ingest: IngestService | undefined,
  handler: (svc: IngestService, body: Partial<TBody> | null) => Promise<void>,
): void {
  if (!ingest) {
    return notReady(res, 'ingest backend not configured');
  }
  let raw = '';
  req.on('data', (c) => (raw += c.toString()));
  req.on('end', async () => {
    const parsed = raw ? safeJson(raw) : null;
    try {
      await handler(ingest, parsed as Partial<TBody> | null);
    } catch (err) {
      serverError(res, (err as Error).message);
    }
  });
}

const UPLOAD_MAX_BYTES = 50 * 1024 * 1024; // CS11 lean: 50 MB cap (F22)

/** Minimal multipart/form-data parser. v1 supports a single `file` part
 *  + optional text parts (description, contentType, productId). Built
 *  from scratch rather than pulling in busboy/formidable to honor the
 *  cold-start budget; the parser is well under 100 lines. */
function handleMultipartUpload(
  req: IncomingMessage,
  res: ServerResponse,
  ingest: IngestService,
  metrics: MetricsCounters,
): void {
  const ct = req.headers['content-type'] ?? '';
  const m = /boundary=("?)([^";]+)\1/.exec(ct);
  if (!m) return badRequest(res, 'content-type must be multipart/form-data with boundary');
  const boundary = `--${m[2]}`;

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  req.on('data', (c: Buffer) => {
    totalBytes += c.length;
    if (totalBytes > UPLOAD_MAX_BYTES) {
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (totalBytes > UPLOAD_MAX_BYTES) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `upload exceeds ${UPLOAD_MAX_BYTES} bytes` }));
      return;
    }
    try {
      const parsed = parseMultipart(Buffer.concat(chunks), boundary);
      const filePart = parsed.parts.find((p) => p.filename);
      if (!filePart || !filePart.filename) {
        return badRequest(res, 'multipart body must include a file part with a filename');
      }
      const textPart = (name: string): string | undefined => {
        const p = parsed.parts.find((q) => q.name === name && !q.filename);
        return p ? p.body.toString('utf8') : undefined;
      };
      const result = await ingest.startUploadIngest({
        filename: filePart.filename,
        contentType: filePart.contentType ?? textPart('contentType'),
        description: textPart('description'),
        productId: textPart('productId'),
        bytes: new Uint8Array(filePart.body),
      });
      metrics.ingestsStarted += 1;
      accepted(res, {
        service: 'context',
        ingestId: result.ingestId,
        entry: result.entry,
        ts: new Date().toISOString(),
      });
    } catch (err) {
      serverError(res, (err as Error).message);
    }
  });
}

interface MultipartPart {
  name?: string;
  filename?: string;
  contentType?: string;
  body: Buffer;
}

function parseMultipart(buf: Buffer, boundary: string): { parts: MultipartPart[] } {
  const boundaryBuf = Buffer.from(boundary);
  const closeBuf = Buffer.from(`${boundary}--`);
  const parts: MultipartPart[] = [];

  let pos = buf.indexOf(boundaryBuf);
  if (pos < 0) return { parts };
  pos += boundaryBuf.length;

  while (pos < buf.length) {
    if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2;
    const next = buf.indexOf(boundaryBuf, pos);
    if (next < 0) break;
    const partRaw = buf.subarray(pos, next - 2);
    const headerEnd = partRaw.indexOf('\r\n\r\n');
    if (headerEnd > 0) {
      const headersStr = partRaw.subarray(0, headerEnd).toString('utf8');
      const body = partRaw.subarray(headerEnd + 4);
      const part: MultipartPart = { body };
      const dispositionMatch = /Content-Disposition: form-data; ([^\r\n]+)/i.exec(headersStr);
      if (dispositionMatch) {
        const disp = dispositionMatch[1] ?? '';
        const name = /name="([^"]+)"/.exec(disp)?.[1];
        const filename = /filename="([^"]*)"/.exec(disp)?.[1];
        if (name) part.name = name;
        if (filename) part.filename = filename;
      }
      const ctMatch = /Content-Type: ([^\r\n]+)/i.exec(headersStr);
      if (ctMatch) part.contentType = ctMatch[1];
      parts.push(part);
    }
    pos = next + boundaryBuf.length;
    if (buf.subarray(next, next + closeBuf.length).equals(closeBuf)) break;
  }
  return { parts };
}

/** Per-connection WebSocket handler for /v1/ingest/events. The client
 *  may send a one-time JSON message `{ subscribe: <ingestId> }` to
 *  filter events; otherwise all events for all ingests stream. */
function attachWsClient(
  ws: import('ws').WebSocket,
  _req: IncomingMessage,
  ingest: IngestService | undefined,
): void {
  if (!ingest) {
    ws.close(1011, 'ingest backend not configured');
    return;
  }

  const send = (event: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };

  const unsubs: Array<() => void> = [];
  let filterId: string | null = null;

  const subscribeAll = () => {
    for (const s of ingest.listIngests()) {
      if (filterId && s.ingestId !== filterId) continue;
      for (const ev of s.events) send({ ingestId: s.ingestId, event: ev });
      const u = ingest.subscribe(s.ingestId, (ev) =>
        send({ ingestId: s.ingestId, event: ev }),
      );
      unsubs.push(u);
    }
  };

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString()) as { subscribe?: string };
      if (typeof msg.subscribe === 'string') {
        filterId = msg.subscribe;
        unsubs.splice(0).forEach((u) => u());
        subscribeAll();
      }
    } catch {
      send({ error: 'invalid JSON' });
    }
  });

  ws.on('close', () => {
    unsubs.splice(0).forEach((u) => u());
  });

  subscribeAll();
  send({ welcome: true, ts: new Date().toISOString() });
}

/** Tiny Prometheus exposition format. v1 covers basic counters; full
 *  Prom client (histograms, labels) deferred to v1.x. */
function formatMetrics(m: MetricsCounters): string {
  const uptime = (Date.now() - m.startedAt) / 1000;
  const lines: string[] = [];
  lines.push('# HELP edge_context_uptime_seconds Server uptime in seconds');
  lines.push('# TYPE edge_context_uptime_seconds gauge');
  lines.push(`edge_context_uptime_seconds ${uptime.toFixed(0)}`);
  lines.push('# HELP edge_context_requests_total Total HTTP requests received');
  lines.push('# TYPE edge_context_requests_total counter');
  lines.push(`edge_context_requests_total ${m.requests}`);
  lines.push('# HELP edge_context_errors_total Total HTTP error responses');
  lines.push('# TYPE edge_context_errors_total counter');
  lines.push(`edge_context_errors_total ${m.errors}`);
  lines.push('# HELP edge_context_ingests_started_total Total ingests kicked off');
  lines.push('# TYPE edge_context_ingests_started_total counter');
  lines.push(`edge_context_ingests_started_total ${m.ingestsStarted}`);
  lines.push('# HELP edge_context_ws_connects_total Total WebSocket upgrades served');
  lines.push('# TYPE edge_context_ws_connects_total counter');
  lines.push(`edge_context_ws_connects_total ${m.wsConnects}`);
  lines.push('# HELP edge_context_idle_throttles_total Times the server idle-released backend resources');
  lines.push('# TYPE edge_context_idle_throttles_total counter');
  lines.push(`edge_context_idle_throttles_total ${m.idleThrottles}`);
  lines.push('# HELP edge_context_requests_by_route_total Requests grouped by route name');
  lines.push('# TYPE edge_context_requests_by_route_total counter');
  for (const [route, count] of Object.entries(m.requestsByRoute)) {
    lines.push(`edge_context_requests_by_route_total{route="${route}"} ${count}`);
  }
  return `${lines.join('\n')}\n`;
}

export type {
  ContextQueryHit,
  ContextQueryRequest,
  ContextQueryResult,
  ContextQueryServiceOptions,
  ContextStatsResult,
  CypherRequest,
  CypherResult,
  QueryService,
  RelatedHit,
  RelatedRequest,
  RelatedResult,
  TraverseEdge,
  TraverseNode,
  TraverseRequest,
  TraverseResult,
} from './query.ts';
export { ContextQueryService } from './query.ts';
export type {
  CrawlIngestRequest,
  EventCallback,
  IngestService,
  IngestServiceOptions,
  IngestState,
  IngestStatus,
  RepoIngestRequest,
  RepoSource,
  UploadEntry,
  UploadIngestRequest,
} from './ingest.ts';
export { ContextIngestService } from './ingest.ts';
export type {
  OpenApiPluginOptions,
  Plugin,
  PluginContext,
  PluginRouteHandler,
  RegisteredPlugin,
} from './plugins.ts';
export { OpenApiPlugin } from './plugins.ts';
export type { CronTask, ParsedCron, ScheduledJob } from './cron.ts';
export { CronScheduler, parseCron, nextFireTime } from './cron.ts';
export type { CrawlRequest, CrawlResult, CrawlScope, CrawlerOptions } from './crawl.ts';
export { Crawler } from './crawl.ts';
export type {
  ConfluenceIngestRequest,
  ConfluencePage,
  ExternalIngestEvent,
  ExternalIngestSummary,
  ExternalSourceFetcher,
  ExternalSourceOptions,
  GithubIssue,
  GithubIssuesIngestRequest,
  JiraIngestRequest,
  JiraIssue,
} from './external-sources.ts';
export {
  ConfluenceFetcher,
  GithubIssuesFetcher,
  JiraFetcher,
  runConfluenceIngest,
  runGithubIssuesIngest,
  runJiraIngest,
} from './external-sources.ts';

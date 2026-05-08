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
  type AuditLog,
  type AuditLogQuery,
  type AuditOp,
  InMemoryAuditLog,
  resolveActor,
} from './audit.ts';
import {
  type ConsolidateInput,
  type ConsolidateStrategy,
  consolidate,
  type SummarizeFn,
} from './consolidate.ts';
import { IdleThrottle, type IdleThrottleOptions } from './idle-throttle.ts';
import { type InspectInput, inspect } from './inspect.ts';
import { Metrics, opForPath } from './metrics.ts';
import { InMemorySnapshotStore, type SnapshotStore } from './snapshot.ts';
import {
  type FeedbackSource,
  InMemoryMemoryStore,
  type MemoryEntry,
  type MemoryForgetPredicate,
  type MemoryPutInput,
  type MemoryQuery,
  type MemoryScope,
  type MemoryStore,
  type MemoryTagInput,
} from './store.ts';

export interface MemoryServerOptions {
  socketPath: string;
  /** Backend store. Defaults to a fresh InMemoryMemoryStore — useful
   *  for tests and dev. Production wires sqlite-vec when the backend
   *  lands (separate slice). */
  store?: MemoryStore;
  /** Audit log. Defaults to a fresh InMemoryAuditLog — sufficient for
   *  tests and dev. Production wires SqliteAuditLog with its own
   *  persistence path. Per PRD F12, every put / forget / import is
   *  recorded with timestamp, scope, op, actor, count, entryIds. */
  audit?: AuditLog;
  /** Process-wide metrics collector. Default: a fresh Metrics. Tests
   *  may inject one to assert counter/histogram state without parsing
   *  /metrics output. */
  metrics?: Metrics;
  /** Idle-throttle config (PRD F9). Default: 10min idle timeout, 30s
   *  check interval, no-op hooks. Pass `idle: false` to disable
   *  throttling entirely (useful for in-process tests where we don't
   *  want a background timer). */
  idle?: IdleThrottleOptions | false;
  /** Optional LLM summarizer for `feedback-summarize` consolidation
   *  strategy (PRD F15). Default: defaultSummarize (concatenation
   *  placeholder). Production wires an Anthropic Messages client. */
  summarize?: SummarizeFn;
  /** Snapshot store (PRD F5). Default: a fresh InMemorySnapshotStore.
   *  Production wires SqliteSnapshotStore for persistence across
   *  daemon restarts. */
  snapshots?: SnapshotStore;
}

export interface MemoryServerHandle {
  /** Reference to the underlying store — exposed so tests can inspect
   *  state without poking through the HTTP surface. Production callers
   *  shouldn't need this; they go through the API. */
  store: MemoryStore;
  /** Reference to the audit log for the same reason — tests can
   *  cross-check audit events against the operations they triggered. */
  audit: AuditLog;
  /** Reference to the metrics collector. */
  metrics: Metrics;
  /** Idle throttle, if enabled. `null` when disabled via `idle: false`. */
  idle: IdleThrottle | null;
  /** Snapshot store. */
  snapshots: SnapshotStore;
  stop(): Promise<void>;
}

const STARTED_AT = Date.now();

export async function startMemoryServer(opts: MemoryServerOptions): Promise<MemoryServerHandle> {
  await mkdir(dirname(opts.socketPath), { recursive: true, mode: 0o700 });
  await unlink(opts.socketPath).catch(() => {});

  const store = opts.store ?? new InMemoryMemoryStore();
  const audit = opts.audit ?? new InMemoryAuditLog();
  const metrics = opts.metrics ?? new Metrics();
  const idle: IdleThrottle | null = opts.idle === false ? null : new IdleThrottle(opts.idle ?? {});
  if (idle) idle.start();
  const summarize = opts.summarize;
  const snapshots = opts.snapshots ?? new InMemorySnapshotStore();
  const server = createServer((req, res) =>
    route(req, res, store, audit, metrics, idle, summarize, snapshots),
  );

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socketPath, () => resolve());
  });

  await chmod(opts.socketPath, 0o600);

  return {
    store,
    audit,
    metrics,
    idle,
    snapshots,
    async stop() {
      idle?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(opts.socketPath).catch(() => {});
    },
  };
}

function route(
  req: IncomingMessage,
  res: ServerResponse,
  store: MemoryStore,
  audit: AuditLog,
  metrics: Metrics,
  idle: IdleThrottle | null,
  summarize: SummarizeFn | undefined,
  snapshots: SnapshotStore,
): void {
  const url = (req.url ?? '/').split('?')[0]!.replace(/\/$/, '') || '/';
  const op = opForPath(url);
  const start = process.hrtime.bigint();

  // Wrap res.end so every response increments the right counters.
  const origEnd = res.end.bind(res);
  // biome-ignore lint/suspicious/noExplicitAny: thin pass-through to Node's overloaded res.end signature
  (res as any).end = (...args: unknown[]) => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    metrics.observeLatency(op, seconds);
    metrics.incRequest(op);
    if (res.statusCode >= 400) metrics.incError(op);
    if (idle) metrics.setIdle(idle.state === 'idle');
    return (origEnd as (...a: unknown[]) => ServerResponse)(...args);
  };

  // GET /metrics — Prometheus exposition. Doesn't count as activity
  // (per F9: scrapes shouldn't keep a quiet daemon warm).
  if (req.method === 'GET' && url === '/metrics') {
    handleMetrics(res, store, metrics).catch((err: Error) => serverError(res, err.message));
    return;
  }

  // GET /health — backend state + size for diagnostic dashboards.
  // Doesn't count as activity for the same reason as /metrics.
  if (req.method === 'GET' && url === '/health') {
    handleHealth(res, store, idle).catch((err: Error) => serverError(res, err.message));
    return;
  }

  // /v1/* paths: this is real client traffic. Record activity for the
  // idle throttle, and ensure-warm before handing off to a handler.
  // ensureWarm is awaited so warmup latency lands in the request, not
  // the next request.
  if (idle) {
    idle.recordActivity();
    if (idle.state === 'idle') {
      idle
        .ensureWarm()
        .then(() => dispatchV1(req, res, store, audit, url, summarize, snapshots))
        .catch((err: Error) => serverError(res, `warmup failed: ${err.message}`));
      return;
    }
  }
  dispatchV1(req, res, store, audit, url, summarize, snapshots);
}

function dispatchV1(
  req: IncomingMessage,
  res: ServerResponse,
  store: MemoryStore,
  audit: AuditLog,
  url: string,
  summarize: SummarizeFn | undefined,
  snapshots: SnapshotStore,
): void {
  // POST /v1/memory/put — body { key, value, scope? }
  if (req.method === 'POST' && url === '/v1/memory/put') {
    consumeJsonBody(req, (parsed, err) => {
      if (err) {
        badRequest(res, err);
        return;
      }
      handlePut(res, store, audit, parsed).catch((e: Error) => serverError(res, e.message));
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

  // POST /v1/memory/forget — body MemoryForgetPredicate { scope?, key?, olderThan? }
  if (req.method === 'POST' && url === '/v1/memory/forget') {
    consumeJsonBody(req, (parsed, err) => {
      if (err) {
        badRequest(res, err);
        return;
      }
      handleForget(res, store, audit, parsed).catch((e: Error) => serverError(res, e.message));
    });
    return;
  }

  // POST /v1/memory/export — body: optional MemoryQuery (defaults to
  // structured-no-filter). Response: text/plain JSONL, one MemoryEntry
  // per line. Empty result → empty body (200, zero lines). Useful for
  // backup-before-forget and migration workflows.
  if (req.method === 'POST' && url === '/v1/memory/export') {
    consumeJsonBody(req, (parsed, err) => {
      if (err) {
        badRequest(res, err);
        return;
      }
      handleExport(res, store, parsed).catch((e: Error) => serverError(res, e.message));
    });
    return;
  }

  // POST /v1/memory/import — body: text/plain JSONL, one MemoryPutInput
  // per line. Each line is parsed + put-ed independently; errors don't
  // halt the run. Response: { imported, errors: [{ line, error }] }.
  // Roundtrip is lossy on id/createdAt (server reissues both); content
  // is preserved.
  if (req.method === 'POST' && url === '/v1/memory/import') {
    handleImport(req, res, store, audit).catch((e: Error) => serverError(res, e.message));
    return;
  }

  // POST /v1/memory/tag — body MemoryTagInput. PRD F18.
  if (req.method === 'POST' && url === '/v1/memory/tag') {
    consumeJsonBody(req, (parsed, err) => {
      if (err) {
        badRequest(res, err);
        return;
      }
      handleTag(res, store, audit, parsed).catch((e: Error) => serverError(res, e.message));
    });
    return;
  }

  // POST /v1/memory/consolidate — body ConsolidateInput. PRD F14/F15.
  if (req.method === 'POST' && url === '/v1/memory/consolidate') {
    consumeJsonBody(req, (parsed, err) => {
      if (err) {
        badRequest(res, err);
        return;
      }
      handleConsolidate(res, store, audit, parsed, summarize).catch((e: Error) =>
        serverError(res, e.message),
      );
    });
    return;
  }

  // POST /v1/memory/cleanup-unconfirmed — body { scope, dryRun? }. PRD F19.
  if (req.method === 'POST' && url === '/v1/memory/cleanup-unconfirmed') {
    consumeJsonBody(req, (parsed, err) => {
      if (err) {
        badRequest(res, err);
        return;
      }
      handleCleanup(res, store, audit, parsed).catch((e: Error) => serverError(res, e.message));
    });
    return;
  }

  // POST /v1/memory/snapshot — body { scope }. PRD F5.
  if (req.method === 'POST' && url === '/v1/memory/snapshot') {
    consumeJsonBody(req, (parsed, err) => {
      if (err) {
        badRequest(res, err);
        return;
      }
      handleSnapshot(res, store, audit, snapshots, parsed).catch((e: Error) =>
        serverError(res, e.message),
      );
    });
    return;
  }

  // POST /v1/memory/restore — body { snapshotId, mode? }. PRD F5.
  if (req.method === 'POST' && url === '/v1/memory/restore') {
    consumeJsonBody(req, (parsed, err) => {
      if (err) {
        badRequest(res, err);
        return;
      }
      handleRestore(res, store, audit, snapshots, parsed).catch((e: Error) =>
        serverError(res, e.message),
      );
    });
    return;
  }

  // POST /v1/memory/inspect — body { scope?, showLineage? }. PRD F37.
  if (req.method === 'POST' && url === '/v1/memory/inspect') {
    consumeJsonBody(req, (parsed, err) => {
      if (err) {
        badRequest(res, err);
        return;
      }
      handleInspect(res, store, parsed).catch((e: Error) => serverError(res, e.message));
    });
    return;
  }

  // POST /v1/audit — body: optional AuditLogQuery filter. Read-only.
  // Response: { events: AuditEvent[], count }. Newest first.
  if (req.method === 'POST' && url === '/v1/audit') {
    consumeJsonBody(req, (parsed, err) => {
      if (err) {
        badRequest(res, err);
        return;
      }
      handleAuditQuery(res, audit, parsed).catch((e: Error) => serverError(res, e.message));
    });
    return;
  }

  // Fallback echo for unknown paths — preserves v0 contract for early
  // bringup checks and tests that haven't migrated yet.
  echo(req, res, 'memory');
}

async function handleMetrics(
  res: ServerResponse,
  store: MemoryStore,
  metrics: Metrics,
): Promise<void> {
  // Refresh entries gauge on every scrape so dashboards aren't stale
  // when nothing else hit the store. Cheap for in-memory, ~0.1ms for
  // SqliteVec.
  metrics.setEntries(await store.size());
  res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
  res.end(metrics.render());
}

async function handleHealth(
  res: ServerResponse,
  store: MemoryStore,
  idle: IdleThrottle | null,
): Promise<void> {
  const size = await store.size();
  ok(res, {
    service: 'memory',
    // PRD F8: state is 'warm' | 'idle' (no 'warming' yet — ensureWarm
    // awaits the transition synchronously, so callers never observe
    // an in-between state).
    state: idle?.state ?? 'warm',
    uptimeMs: Date.now() - STARTED_AT,
    backend: store.constructor.name,
    entryCount: size,
    ts: new Date().toISOString(),
  });
}

async function handlePut(
  res: ServerResponse,
  store: MemoryStore,
  audit: AuditLog,
  body: unknown,
): Promise<void> {
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
  await audit.append({
    op: 'put',
    actor: resolveActor(),
    count: 1,
    entryIds: [entry.id],
    ...(input.scope ? { scope: input.scope } : {}),
  });
  ok(res, {
    service: 'memory',
    method: 'POST',
    path: '/v1/memory/put',
    entry,
    ts: new Date().toISOString(),
  });
}

async function handleForget(
  res: ServerResponse,
  store: MemoryStore,
  audit: AuditLog,
  body: unknown,
): Promise<void> {
  if (!isObject(body)) {
    badRequest(res, 'body must be a JSON MemoryForgetPredicate object');
    return;
  }
  // Loosely validate shape; the store itself enforces the
  // "at-least-one-field" rule via assertNonEmptyForgetPredicate.
  const predicate: MemoryForgetPredicate = {};
  const b = body as Record<string, unknown>;
  if (typeof b.key === 'string') predicate.key = b.key;
  if (typeof b.olderThan === 'string') predicate.olderThan = b.olderThan;
  if (isScope(b.scope)) predicate.scope = b.scope as MemoryScope;
  try {
    const result = await store.forget(predicate);
    // Only audit if something was actually deleted; an empty-match
    // forget shouldn't pollute the log. The forget API returns
    // deleted=0 cleanly, so this filters those out.
    if (result.deleted > 0) {
      await audit.append({
        op: 'forget',
        actor: resolveActor(),
        count: result.deleted,
        entryIds: result.deletedIds,
        ...(predicate.scope ? { scope: predicate.scope } : {}),
      });
    }
    ok(res, {
      service: 'memory',
      method: 'POST',
      path: '/v1/memory/forget',
      result,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
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

/**
 * Export entries matching an optional MemoryQuery as JSONL. Each line
 * is a serialized MemoryEntry. No body / `{}` body → exports
 * everything via a `kind:'structured'` no-filter query.
 *
 * Response Content-Type is `text/plain` (not `application/x-ndjson` —
 * MIME registries are inconsistent on JSONL/NDJSON; plain text + a
 * `.jsonl` extension on the destination file is the simplest interop
 * with curl pipes, jq, and shell tooling).
 *
 * Returns 400 on `kind:'similarity' | 'graph'` queries — those don't
 * have natural "all matching entries" semantics for export.
 */
async function handleExport(res: ServerResponse, store: MemoryStore, body: unknown): Promise<void> {
  const query =
    isObject(body) && Object.keys(body).length > 0
      ? (body as MemoryQuery)
      : { kind: 'structured' as const };
  if (query.kind === 'similarity' || query.kind === 'graph') {
    badRequest(res, `cannot export with kind=${query.kind}; use structured or recent`);
    return;
  }
  const result = await store.query(query);
  if (result.kind === 'unsupported') {
    badRequest(res, `export query unsupported: ${result.reason}`);
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  for (const entry of result.entries) {
    res.write(`${JSON.stringify(entry)}\n`);
  }
  res.end();
}

/**
 * Import entries from a JSONL request body. Each non-empty line is
 * parsed as MemoryPutInput and put-ed independently. Errors are
 * collected per-line; the run doesn't halt on first failure.
 *
 * The roundtrip is intentionally lossy on identity: server reissues
 * `id` + `createdAt` for every imported entry. Content (key, value,
 * scope) is preserved verbatim. Document this in caller-facing
 * surfaces — the audit log should reflect the *import* moment, not
 * the original write.
 */
async function handleImport(
  req: IncomingMessage,
  res: ServerResponse,
  store: MemoryStore,
  audit: AuditLog,
): Promise<void> {
  let body = '';
  await new Promise<void>((resolve, reject) => {
    req.on('data', (c) => {
      body += c.toString();
    });
    req.on('end', () => resolve());
    req.on('error', reject);
  });

  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let imported = 0;
  const importedIds: string[] = [];
  const errors: Array<{ line: number; error: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const raw = lines[i]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      errors.push({ line: lineNum, error: `invalid JSON: ${(err as Error).message}` });
      continue;
    }
    if (!isObject(parsed)) {
      errors.push({ line: lineNum, error: 'line must be a JSON object' });
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const key = obj.key;
    const value = obj.value;
    if (typeof key !== 'string' || key.length === 0) {
      errors.push({ line: lineNum, error: 'missing or empty `key`' });
      continue;
    }
    if (value === undefined) {
      errors.push({ line: lineNum, error: 'missing `value`' });
      continue;
    }
    try {
      const entry = await store.put({
        key,
        value,
        ...(isScope(obj.scope) ? { scope: obj.scope as MemoryScope } : {}),
      });
      imported++;
      // Cap entryIds sample at 100 — for a 10K-line import we don't
      // need every id in the audit row, just a representative sample.
      // The `count` is authoritative.
      if (importedIds.length < 100) importedIds.push(entry.id);
    } catch (err) {
      errors.push({ line: lineNum, error: (err as Error).message });
    }
  }

  // One audit event for the whole import operation, not N events for
  // N lines — bulk semantics. Skip when nothing was imported (an
  // all-errors run shouldn't pollute the audit log with zero-count
  // events).
  if (imported > 0) {
    await audit.append({
      op: 'import',
      actor: resolveActor(),
      count: imported,
      entryIds: importedIds,
    });
  }

  ok(res, {
    service: 'memory',
    method: 'POST',
    path: '/v1/memory/import',
    result: { imported, errors },
    ts: new Date().toISOString(),
  });
}

/**
 * PRD F18 — feedback-tag entries. Updates provenance.feedback +
 * feedbackSource + feedbackAt. Skips already-tagged entries when
 * overwrite=false (default).
 */
async function handleTag(
  res: ServerResponse,
  store: MemoryStore,
  audit: AuditLog,
  body: unknown,
): Promise<void> {
  if (!isObject(body)) {
    badRequest(res, 'body must be a JSON MemoryTagInput object');
    return;
  }
  const b = body as Record<string, unknown>;
  if (b.feedback !== 'positive' && b.feedback !== 'negative') {
    badRequest(res, "body.feedback is required ('positive' | 'negative')");
    return;
  }
  const input: MemoryTagInput = { feedback: b.feedback };
  if (Array.isArray(b.entryIds) && b.entryIds.every((x) => typeof x === 'string')) {
    input.entryIds = b.entryIds as string[];
  }
  if (typeof b.key === 'string') input.key = b.key;
  if (typeof b.olderThan === 'string') input.olderThan = b.olderThan;
  if (isScope(b.scope)) input.scope = b.scope;
  if (typeof b.feedbackSource === 'string')
    input.feedbackSource = b.feedbackSource as FeedbackSource;
  if (b.overwrite === true) input.overwrite = true;

  try {
    const result = await store.tag(input);
    if (result.tagged > 0) {
      await audit.append({
        op: 'tag',
        actor: resolveActor(),
        count: result.tagged,
        entryIds: result.taggedIds,
        ...(input.scope ? { scope: input.scope } : {}),
      });
    }
    ok(res, {
      service: 'memory',
      method: 'POST',
      path: '/v1/memory/tag',
      result,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}

/**
 * PRD F37 — inspect surface. Composes the existing query interface
 * + JS aggregation (cap ~1M entries per PRD §5; SQL GROUP BY is a
 * v1.x optimization).
 */
async function handleInspect(
  res: ServerResponse,
  store: MemoryStore,
  body: unknown,
): Promise<void> {
  const input: InspectInput = {};
  if (isObject(body)) {
    const b = body as Record<string, unknown>;
    if (isScope(b.scope)) input.scope = b.scope as MemoryScope;
    if (b.showLineage === true) input.showLineage = true;
  }
  const result = await inspect(input, store);
  ok(res, {
    service: 'memory',
    method: 'POST',
    path: '/v1/memory/inspect',
    result,
    ts: new Date().toISOString(),
  });
}

/**
 * PRD F5 — snapshot all entries matching `scope` into the SnapshotStore.
 * Returns the new snapshotId + count. Memory store is NOT modified —
 * snapshot is a read-only capture.
 */
async function handleSnapshot(
  res: ServerResponse,
  store: MemoryStore,
  audit: AuditLog,
  snapshots: SnapshotStore,
  body: unknown,
): Promise<void> {
  if (!isObject(body)) {
    badRequest(res, 'body must be a JSON object with { scope }');
    return;
  }
  const b = body as Record<string, unknown>;
  if (!isScope(b.scope)) {
    badRequest(res, 'body.scope is required and must be a valid MemoryScope object');
    return;
  }
  const scope = b.scope as MemoryScope;
  if (!Object.values(scope).some((v) => v !== undefined)) {
    badRequest(res, 'body.scope must have at least one set field (refusing global snapshot)');
    return;
  }
  // Pull every entry matching the scope. recent + huge limit is the
  // path that returns all matches; structured-with-no-key works too.
  const q = await store.query({ kind: 'recent', scope, limit: 100_000 });
  if (q.kind !== 'ok') {
    badRequest(res, `snapshot source query unsupported: ${q.reason}`);
    return;
  }
  const snap = await snapshots.save(scope, q.entries);
  await audit.append({
    op: 'snapshot',
    actor: resolveActor(),
    count: q.entries.length,
    entryIds: q.entries.slice(0, 100).map((e) => e.id),
    scope,
  });
  ok(res, {
    service: 'memory',
    method: 'POST',
    path: '/v1/memory/snapshot',
    result: { snapshotId: snap.id, count: q.entries.length, createdAt: snap.createdAt },
    ts: new Date().toISOString(),
  });
}

/**
 * PRD F5 — restore a snapshot by id. Default mode='replace' wipes the
 * snapshot's scope first, then re-puts the captured entries; mode='merge'
 * skips the wipe. Server reissues each entry's id (lossy roundtrip,
 * same constraint as JSONL import).
 */
async function handleRestore(
  res: ServerResponse,
  store: MemoryStore,
  audit: AuditLog,
  snapshots: SnapshotStore,
  body: unknown,
): Promise<void> {
  if (!isObject(body)) {
    badRequest(res, 'body must be a JSON object with { snapshotId, mode? }');
    return;
  }
  const b = body as Record<string, unknown>;
  const snapshotId = b.snapshotId;
  if (typeof snapshotId !== 'string') {
    badRequest(res, 'body.snapshotId is required (string)');
    return;
  }
  const mode = b.mode === 'merge' ? 'merge' : 'replace';
  const snap = await snapshots.load(snapshotId);
  if (!snap) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `snapshot not found: ${snapshotId}` }));
    return;
  }
  if (mode === 'replace') {
    // Wipe the scope before re-applying. Empty result is OK — that
    // just means the scope was already empty.
    const hasField = Object.values(snap.scope).some((v) => v !== undefined);
    if (hasField) {
      await store.forget({ scope: snap.scope });
    }
  }
  const restoredIds: string[] = [];
  for (const e of snap.entries as MemoryEntry[]) {
    const newEntry = await store.put({
      key: e.key,
      value: e.value,
      scope: e.scope,
      provenance: e.provenance,
    });
    if (restoredIds.length < 100) restoredIds.push(newEntry.id);
  }
  await audit.append({
    op: 'restore',
    actor: resolveActor(),
    count: snap.entries.length,
    entryIds: restoredIds,
    scope: snap.scope,
  });
  ok(res, {
    service: 'memory',
    method: 'POST',
    path: '/v1/memory/restore',
    result: { restored: snap.entries.length, mode, snapshotId },
    ts: new Date().toISOString(),
  });
}

/**
 * PRD F19 — clean up unconfirmed entries within a scope (typically
 * `{jobId}` at session-end). Composes forget with the new
 * feedback='unconfirmed' predicate. Returns the same { deleted,
 * deletedIds } shape as forget.
 *
 * Operationally this is "the half of consolidation that doesn't
 * promote": the residual unlabeled entries that no feedback hook ever
 * tagged. The PRD's `MEMORY_PRESERVE_UNCONFIRMED` opt-out is enforced
 * by the caller (don't call this endpoint if you set the env var) —
 * the daemon doesn't second-guess a deliberate request.
 */
async function handleCleanup(
  res: ServerResponse,
  store: MemoryStore,
  audit: AuditLog,
  body: unknown,
): Promise<void> {
  if (!isObject(body)) {
    badRequest(res, 'body must be a JSON object with at least { scope }');
    return;
  }
  const b = body as Record<string, unknown>;
  if (!isScope(b.scope)) {
    badRequest(res, 'body.scope is required and must be a valid MemoryScope object');
    return;
  }
  const scope = b.scope as MemoryScope;
  if (!Object.values(scope).some((v) => v !== undefined)) {
    badRequest(
      res,
      'body.scope must have at least one set field (refusing global unconfirmed wipe)',
    );
    return;
  }
  try {
    const result = await store.forget({ scope, feedback: 'unconfirmed' });
    if (result.deleted > 0) {
      await audit.append({
        op: 'cleanup',
        actor: resolveActor(),
        count: result.deleted,
        entryIds: result.deletedIds,
        scope,
      });
    }
    ok(res, {
      service: 'memory',
      method: 'POST',
      path: '/v1/memory/cleanup-unconfirmed',
      result,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}

/**
 * PRD F14/F15 — promote feedback-tagged entries from a narrow scope
 * to a wider one. Pure-orchestration module does the work; this just
 * marshals the body and shapes the response.
 */
async function handleConsolidate(
  res: ServerResponse,
  store: MemoryStore,
  audit: AuditLog,
  body: unknown,
  summarize: SummarizeFn | undefined,
): Promise<void> {
  if (!isObject(body)) {
    badRequest(res, 'body must be a JSON ConsolidateInput object');
    return;
  }
  const b = body as Record<string, unknown>;
  if (!isObject(b.from) || !isObject(b.to)) {
    badRequest(res, 'body.from and body.to are required (objects with .scope)');
    return;
  }
  const fromScope = (b.from as Record<string, unknown>).scope;
  const toScope = (b.to as Record<string, unknown>).scope;
  if (!isScope(fromScope) || !isScope(toScope)) {
    badRequest(res, 'from.scope and to.scope must be valid MemoryScope objects');
    return;
  }
  const input: ConsolidateInput = {
    from: { scope: fromScope as MemoryScope },
    to: { scope: toScope as MemoryScope },
  };
  if (
    b.strategy === 'feedback-required' ||
    b.strategy === 'feedback-by-topic' ||
    b.strategy === 'feedback-summarize' ||
    b.strategy === 'include-all'
  ) {
    input.strategy = b.strategy as ConsolidateStrategy;
  }
  if (Array.isArray(b.feedbackFilter)) {
    input.feedbackFilter = b.feedbackFilter as Array<'positive' | 'negative'>;
  }
  if (typeof b.topic === 'string') input.topic = b.topic;
  if (b.keepSource === true) input.keepSource = true;

  try {
    const result = await consolidate(input, store, audit, { summarize });
    ok(res, {
      service: 'memory',
      method: 'POST',
      path: '/v1/memory/consolidate',
      result,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}

/**
 * Read-only audit query. Body is an optional AuditLogQuery; missing
 * fields are wildcards. Newest first; default limit 100.
 */
async function handleAuditQuery(
  res: ServerResponse,
  audit: AuditLog,
  body: unknown,
): Promise<void> {
  const filter: AuditLogQuery = {};
  if (isObject(body)) {
    const b = body as Record<string, unknown>;
    if (typeof b.since === 'string') filter.since = b.since;
    if (typeof b.until === 'string') filter.until = b.until;
    if (
      b.op === 'put' ||
      b.op === 'forget' ||
      b.op === 'import' ||
      b.op === 'tag' ||
      b.op === 'consolidate' ||
      b.op === 'cleanup' ||
      b.op === 'snapshot' ||
      b.op === 'restore'
    ) {
      filter.op = b.op as AuditOp;
    }
    if (typeof b.actor === 'string') filter.actor = b.actor;
    if (typeof b.limit === 'number') filter.limit = b.limit;
    if (isScope(b.scope)) filter.scope = b.scope as MemoryScope;
  }
  const events = await audit.query(filter);
  ok(res, {
    service: 'memory',
    method: 'POST',
    path: '/v1/audit',
    result: { events, count: events.length },
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
  type AuditEvent,
  type AuditLog,
  type AuditLogQuery,
  type AuditOp,
  DEFAULT_ACTOR,
  InMemoryAuditLog,
  matchesAuditFilter,
  resolveActor,
} from './audit.ts';
export {
  type ConsolidateInput,
  type ConsolidateOptions,
  type ConsolidateResult,
  type ConsolidateStrategy,
  consolidate,
  defaultSummarize,
  type SummarizeFn,
} from './consolidate.ts';
export {
  type IdleState,
  IdleThrottle,
  type IdleThrottleOptions,
} from './idle-throttle.ts';
export {
  type InspectInput,
  type InspectResult,
  type InspectScopeBreakdown,
  inspect,
} from './inspect.ts';
export { type MetricOp, Metrics, opForPath } from './metrics.ts';
export {
  InMemorySnapshotStore,
  type MemorySnapshot,
  type SnapshotStore,
} from './snapshot.ts';
export {
  SqliteAuditLog,
  type SqliteAuditLogOptions,
} from './sqlite-audit-log.ts';
export {
  SqliteSnapshotStore,
  type SqliteSnapshotStoreOptions,
} from './sqlite-snapshot.ts';
export {
  type EmbedFn,
  SqliteVecMemoryStore,
  type SqliteVecMemoryStoreOptions,
} from './sqlite-vec-store.ts';
export {
  assertNonEmptyForgetPredicate,
  assertNonEmptyTagInput,
  defaultProvenance,
  type FeedbackSource,
  InMemoryMemoryStore,
  type MemoryEntry,
  type MemoryForgetPredicate,
  type MemoryForgetResult,
  type MemoryProvenance,
  type MemoryPutInput,
  type MemoryQuery,
  type MemoryQueryResult,
  type MemoryScope,
  type MemoryStore,
  type MemoryTagInput,
  type MemoryTagResult,
  matchesForgetPredicate,
} from './store.ts';

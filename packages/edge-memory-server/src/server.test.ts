/**
 * HTTP/UDS round-trip tests for the edge-memory-server. Spawns a real
 * server (in-process, on a tmp socket), exercises the routes via
 * node:http over the UDS, asserts response shapes.
 *
 * These are e2e for the server; the harness-CLI integration is tested
 * separately in harness-cli.
 */

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startMemoryServer } from './index.ts';

const tmpSocket = () => join(tmpdir(), `mem-${randomUUID().slice(0, 8)}.sock`);

interface UdsResponse {
  status: number;
  body: any;
}

/**
 * Text-payload variant for endpoints where the wire shape isn't a
 * single JSON object (export response, import request). Sends/receives
 * raw strings; status code preserved.
 */
function udsText(
  socketPath: string,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
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

describe('edge-memory-server HTTP routes', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('GET /health returns service state + entry count', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await udsJson(socketPath, 'GET', '/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.service).toBe('memory');
    expect(r.body.state).toBe('warm');
    expect(r.body.backend).toBe('InMemoryMemoryStore');
    expect(r.body.entryCount).toBe(0);
    expect(typeof r.body.uptimeMs).toBe('number');
  });

  it('POST /v1/memory/put → POST /v1/memory/query (structured) round-trip', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const putR = await udsJson(socketPath, 'POST', '/v1/memory/put', {
      key: 'plan',
      value: 'use OAuth, not JWT',
      scope: { productId: 'web', userId: 'alice' },
    });
    expect(putR.status).toBe(200);
    expect(putR.body.ok).toBe(true);
    expect(putR.body.entry.key).toBe('plan');
    expect(putR.body.entry.value).toBe('use OAuth, not JWT');
    expect(putR.body.entry.scope).toEqual({ productId: 'web', userId: 'alice' });
    expect(putR.body.entry.id).toMatch(/^mem_/);

    const queryR = await udsJson(socketPath, 'POST', '/v1/memory/query', {
      kind: 'structured',
      key: 'plan',
      scope: { productId: 'web' },
    });
    expect(queryR.status).toBe(200);
    expect(queryR.body.result.kind).toBe('ok');
    expect(queryR.body.result.entries).toHaveLength(1);
    expect(queryR.body.result.entries[0].value).toBe('use OAuth, not JWT');
  });

  it('POST /v1/memory/query (recent) returns newest-first', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    for (const v of ['first', 'second', 'third']) {
      await udsJson(socketPath, 'POST', '/v1/memory/put', { key: 'log', value: v });
      // Small delay so timestamps differ.
      await new Promise((r) => setTimeout(r, 5));
    }

    const r = await udsJson(socketPath, 'POST', '/v1/memory/query', {
      kind: 'recent',
      limit: 2,
    });
    expect(r.status).toBe(200);
    expect(r.body.result.kind).toBe('ok');
    expect(r.body.result.entries.map((e: { value: unknown }) => e.value)).toEqual([
      'third',
      'second',
    ]);
  });

  it('POST /v1/memory/query (similarity) returns kind=unsupported', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await udsJson(socketPath, 'POST', '/v1/memory/query', {
      kind: 'similarity',
      q: 'anything',
    });
    expect(r.status).toBe(200);
    expect(r.body.result.kind).toBe('unsupported');
    expect(r.body.result.reason).toMatch(/sqlite-vec/);
  });

  it('POST /v1/memory/put with missing key returns 400', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await udsJson(socketPath, 'POST', '/v1/memory/put', { value: 'orphan' });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/key/);
  });

  it('POST /v1/memory/query with unknown kind returns 400', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await udsJson(socketPath, 'POST', '/v1/memory/query', {
      kind: 'unknown-kind',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/structured|recent|similarity|graph/);
  });

  it('POST /v1/memory/forget deletes by predicate, returns count + sample ids', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    await udsJson(socketPath, 'POST', '/v1/memory/put', { key: 'plan', value: 'A' });
    await udsJson(socketPath, 'POST', '/v1/memory/put', { key: 'plan', value: 'B' });
    await udsJson(socketPath, 'POST', '/v1/memory/put', { key: 'other', value: 'C' });

    const r = await udsJson(socketPath, 'POST', '/v1/memory/forget', { key: 'plan' });
    expect(r.status).toBe(200);
    expect(r.body.result.deleted).toBe(2);
    expect(r.body.result.deletedIds).toHaveLength(2);

    const remaining = await udsJson(socketPath, 'POST', '/v1/memory/query', {
      kind: 'structured',
    });
    expect(remaining.body.result.entries).toHaveLength(1);
    expect(remaining.body.result.entries[0].value).toBe('C');
  });

  it('POST /v1/memory/forget rejects empty predicate with 400', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await udsJson(socketPath, 'POST', '/v1/memory/forget', {});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/at least one of/);
  });

  it('POST /v1/memory/export streams matching entries as JSONL', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    await udsJson(socketPath, 'POST', '/v1/memory/put', {
      key: 'a',
      value: 'A',
      scope: { productId: 'web' },
    });
    await udsJson(socketPath, 'POST', '/v1/memory/put', {
      key: 'b',
      value: 'B',
      scope: { productId: 'api' },
    });
    await udsJson(socketPath, 'POST', '/v1/memory/put', { key: 'c', value: 'C' });

    // Export everything (no body / empty body).
    const r = await udsText(socketPath, 'POST', '/v1/memory/export', '{}');
    expect(r.status).toBe(200);
    const lines = r.body
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const entry = JSON.parse(line);
      expect(entry.id).toMatch(/^mem_/);
      expect(entry.key).toBeTruthy();
      expect(entry.createdAt).toMatch(/^\d{4}/);
    }

    // Export with scope filter.
    const filtered = await udsText(
      socketPath,
      'POST',
      '/v1/memory/export',
      JSON.stringify({ kind: 'structured', scope: { productId: 'web' } }),
    );
    const filteredLines = filtered.body
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(filteredLines).toHaveLength(1);
    expect(JSON.parse(filteredLines[0]!).value).toBe('A');
  });

  it('POST /v1/memory/export rejects similarity / graph kinds with 400', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await udsText(
      socketPath,
      'POST',
      '/v1/memory/export',
      JSON.stringify({ kind: 'similarity', q: 'x' }),
    );
    expect(r.status).toBe(400);
  });

  it('POST /v1/memory/import parses JSONL, puts each line, reports errors per-line', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const jsonl = [
      JSON.stringify({ key: 'plan', value: 'A', scope: { productId: 'web' } }),
      JSON.stringify({ key: 'plan', value: 'B' }),
      'not-json{',
      JSON.stringify({ value: 'orphan' }), // missing key
      JSON.stringify({ key: 'ok', value: 'C' }),
    ].join('\n');

    const r = await udsText(socketPath, 'POST', '/v1/memory/import', jsonl);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.result.imported).toBe(3);
    expect(body.result.errors).toHaveLength(2);
    expect(body.result.errors[0].line).toBe(3);
    expect(body.result.errors[0].error).toMatch(/invalid JSON/);
    expect(body.result.errors[1].line).toBe(4);
    expect(body.result.errors[1].error).toMatch(/missing or empty `key`/);

    // Confirm via query.
    const all = await udsJson(socketPath, 'POST', '/v1/memory/query', { kind: 'structured' });
    expect(all.body.result.entries).toHaveLength(3);
  });

  it('roundtrip: export then import preserves content (ids reissued)', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    await udsJson(socketPath, 'POST', '/v1/memory/put', { key: 'plan', value: 'A' });
    await udsJson(socketPath, 'POST', '/v1/memory/put', { key: 'plan', value: 'B' });

    const exported = await udsText(socketPath, 'POST', '/v1/memory/export', '{}');
    const originalIds = exported.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).id);

    // Wipe + re-import.
    await udsJson(socketPath, 'POST', '/v1/memory/forget', { key: 'plan' });
    expect(
      (await udsJson(socketPath, 'POST', '/v1/memory/query', { kind: 'structured' })).body.result
        .entries,
    ).toHaveLength(0);

    const imp = await udsText(socketPath, 'POST', '/v1/memory/import', exported.body);
    expect(JSON.parse(imp.body).result.imported).toBe(2);

    const reQueried = await udsJson(socketPath, 'POST', '/v1/memory/query', { kind: 'structured' });
    expect(reQueried.body.result.entries).toHaveLength(2);
    // Content preserved.
    const values = reQueried.body.result.entries.map((e: { value: unknown }) => e.value);
    expect(values.sort()).toEqual(['A', 'B']);
    // Ids reissued (lossy on identity).
    const newIds = reQueried.body.result.entries.map((e: { id: string }) => e.id);
    for (const newId of newIds) {
      expect(originalIds).not.toContain(newId);
    }
  });

  it('every put logs one audit event with op=put + scope + entryId', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    await udsJson(socketPath, 'POST', '/v1/memory/put', {
      key: 'plan',
      value: 'A',
      scope: { productId: 'web' },
    });

    const r = await udsJson(socketPath, 'POST', '/v1/audit', {});
    expect(r.body.result.events).toHaveLength(1);
    const ev = r.body.result.events[0];
    expect(ev.op).toBe('put');
    expect(ev.count).toBe(1);
    expect(ev.scope.productId).toBe('web');
    expect(ev.entryIds).toHaveLength(1);
    expect(ev.entryIds[0]).toMatch(/^mem_/);
    // Per PRD F33: actor is uds:<uid> on POSIX (real running uid),
    // uds:local on Windows (no getuid).
    expect(ev.actor).toMatch(/^uds:(\d+|local)$/);
  });

  it('forget logs one event with the deleted ids; empty-match forgets do NOT', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    await udsJson(socketPath, 'POST', '/v1/memory/put', { key: 'a', value: 'A' });
    await udsJson(socketPath, 'POST', '/v1/memory/put', { key: 'a', value: 'B' });

    // No-match forget — should NOT generate an audit event.
    const before = await udsJson(socketPath, 'POST', '/v1/audit', { op: 'forget' });
    expect(before.body.result.events).toHaveLength(0);
    await udsJson(socketPath, 'POST', '/v1/memory/forget', { key: 'nonexistent' });
    const stillEmpty = await udsJson(socketPath, 'POST', '/v1/audit', { op: 'forget' });
    expect(stillEmpty.body.result.events).toHaveLength(0);

    // Real forget — generates one event.
    await udsJson(socketPath, 'POST', '/v1/memory/forget', { key: 'a' });
    const r = await udsJson(socketPath, 'POST', '/v1/audit', { op: 'forget' });
    expect(r.body.result.events).toHaveLength(1);
    expect(r.body.result.events[0].count).toBe(2);
    expect(r.body.result.events[0].entryIds).toHaveLength(2);
  });

  it('import logs one event with op=import + count + sample ids', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const jsonl = [
      JSON.stringify({ key: 'a', value: 'A' }),
      JSON.stringify({ key: 'b', value: 'B' }),
      JSON.stringify({ key: 'c', value: 'C' }),
    ].join('\n');
    await udsText(socketPath, 'POST', '/v1/memory/import', jsonl);

    const r = await udsJson(socketPath, 'POST', '/v1/audit', { op: 'import' });
    expect(r.body.result.events).toHaveLength(1);
    expect(r.body.result.events[0].count).toBe(3);
    expect(r.body.result.events[0].entryIds).toHaveLength(3);
  });

  it('audit query filters by op + scope', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    await udsJson(socketPath, 'POST', '/v1/memory/put', {
      key: 'a',
      value: 'A',
      scope: { productId: 'web' },
    });
    await udsJson(socketPath, 'POST', '/v1/memory/put', {
      key: 'b',
      value: 'B',
      scope: { productId: 'api' },
    });
    await udsJson(socketPath, 'POST', '/v1/memory/forget', {
      scope: { productId: 'web' },
    });

    const allPuts = await udsJson(socketPath, 'POST', '/v1/audit', { op: 'put' });
    expect(allPuts.body.result.events).toHaveLength(2);

    const webOnly = await udsJson(socketPath, 'POST', '/v1/audit', {
      scope: { productId: 'web' },
    });
    // 1 put (web) + 1 forget (web) = 2
    expect(webOnly.body.result.events).toHaveLength(2);
    const ops = webOnly.body.result.events.map((e: { op: string }) => e.op).sort();
    expect(ops).toEqual(['forget', 'put']);
  });

  it('invalid JSON body returns 400', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await new Promise<UdsResponse>((resolve, reject) => {
      const req = request(
        {
          socketPath,
          path: '/v1/memory/put',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c.toString()));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode ?? 0, body: buf ? JSON.parse(buf) : null });
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on('error', reject);
      req.write('not-json{');
      req.end();
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid JSON/);
  });
});

describe('Idle throttling (PRD F9)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('/health surfaces idle state', async () => {
    const socketPath = tmpSocket();
    // Throttle disabled → state always 'warm'.
    const handle = await startMemoryServer({ socketPath, idle: false });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });
    const r = await udsJson(socketPath, 'GET', '/health');
    expect(r.body.state).toBe('warm');
  });

  it('/v1/* request after idle awaits onWarm before responding', async () => {
    const socketPath = tmpSocket();
    let onWarmCalls = 0;
    let onIdleCalls = 0;
    const handle = await startMemoryServer({
      socketPath,
      idle: {
        idleTimeoutMs: 50,
        checkIntervalMs: 10,
        onIdle: async () => {
          onIdleCalls++;
        },
        onWarm: async () => {
          onWarmCalls++;
        },
      },
    });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    // Wait long enough for the throttle to flip to idle.
    await new Promise((r) => setTimeout(r, 120));
    expect(handle.idle?.state).toBe('idle');
    expect(onIdleCalls).toBe(1);

    // First /v1/* request should re-warm.
    const put = await udsJson(socketPath, 'POST', '/v1/memory/put', { key: 'k', value: 'v' });
    expect(put.status).toBe(200);
    expect(handle.idle?.state).toBe('warm');
    expect(onWarmCalls).toBe(1);

    // /health doesn't tick activity; /v1/* did, so state stays warm
    // for as long as we keep poking it.
    await udsJson(socketPath, 'POST', '/v1/memory/put', { key: 'k2', value: 'v2' });
    expect(handle.idle?.state).toBe('warm');
    expect(onWarmCalls).toBe(1); // not called again — we stayed warm
  });

  it('/health and /metrics scrapes do not count as activity', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({
      socketPath,
      idle: { idleTimeoutMs: 80, checkIntervalMs: 10 },
    });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    // Hit /health + /metrics repeatedly. They should NOT prevent idle
    // transition.
    for (let i = 0; i < 5; i++) {
      await udsJson(socketPath, 'GET', '/health');
      await udsText(socketPath, 'GET', '/metrics');
      await new Promise((r) => setTimeout(r, 20));
    }
    // Total elapsed > 80ms idleTimeout, no /v1/* traffic.
    await new Promise((r) => setTimeout(r, 100));
    expect(handle.idle?.state).toBe('idle');
  });
});

describe('GET /metrics — Prometheus exposition (PRD F13)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('exposes counters that increment per request', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    await udsJson(socketPath, 'POST', '/v1/memory/put', { key: 'k', value: 'v' });
    await udsJson(socketPath, 'POST', '/v1/memory/put', { key: 'k2', value: 'v2' });
    await udsJson(socketPath, 'POST', '/v1/memory/query', { kind: 'recent', limit: 5 });

    const r = await udsText(socketPath, 'GET', '/metrics');
    expect(r.status).toBe(200);
    expect(r.body).toContain('# TYPE edge_memory_requests_total counter');
    expect(r.body).toMatch(/edge_memory_requests_total\{op="put"\} 2/);
    expect(r.body).toMatch(/edge_memory_requests_total\{op="query"\} 1/);
    // Histogram buckets present.
    expect(r.body).toContain('edge_memory_request_duration_seconds_bucket{op="put"');
    // Entries gauge reflects store size.
    expect(r.body).toMatch(/edge_memory_entries_total 2/);
    // Idle gauge default 0.
    expect(r.body).toContain('edge_memory_idle_state 0');
  });

  it('counts errors separately on 4xx', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    // forget without predicate → 400.
    await udsJson(socketPath, 'POST', '/v1/memory/forget', {});

    const r = await udsText(socketPath, 'GET', '/metrics');
    expect(r.body).toMatch(/edge_memory_requests_total\{op="forget"\} 1/);
    expect(r.body).toMatch(/edge_memory_errors_total\{op="forget"\} 1/);
  });

  it('uses content-type=text/plain with version=0.0.4 (Prometheus convention)', async () => {
    const socketPath = tmpSocket();
    const handle = await startMemoryServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await new Promise<{ headers: Record<string, string>; body: string }>(
      (resolve, reject) => {
        const req = request({ socketPath, path: '/metrics', method: 'GET' }, (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c.toString()));
          res.on('end', () =>
            resolve({
              headers: res.headers as Record<string, string>,
              body: buf,
            }),
          );
        });
        req.on('error', reject);
        req.end();
      },
    );
    expect(r.headers['content-type']).toMatch(/text\/plain.*version=0\.0\.4/);
  });
});

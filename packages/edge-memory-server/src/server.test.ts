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

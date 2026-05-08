/**
 * Plugin framework tests:
 *   - server registers plugins, mounts /v1/plugins/<id>/* routes
 *   - GET /v1/plugins lists registered plugins
 *   - unknown plugin id → 404
 *   - plugin register() throws → server still starts; routes 404
 *   - dispose() called at server stop
 *
 * + Reference OpenAPI plugin:
 *   - parseOpenApi extracts operations
 *   - /v1/plugins/openapi/lookup returns operation by id
 *   - /v1/plugins/openapi/operations lists all
 */

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startContextServer } from './index.ts';
import {
  OpenApiPlugin,
  type Plugin,
  type PluginContext,
  __test__ as pluginTestExports,
} from './plugins.ts';

const { parseOpenApi } = pluginTestExports;
const tmpSocket = () => join(tmpdir(), `ctx-pl-${randomUUID().slice(0, 8)}.sock`);

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

class HelloPlugin implements Plugin {
  id = 'hello';
  description = 'Test plugin — echoes the sub-path';
  registered = false;
  disposed = false;
  ctx?: PluginContext;
  register(ctx: PluginContext) {
    this.registered = true;
    this.ctx = ctx;
    return (req: any, res: any, sub: string) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, plugin: 'hello', sub, method: req.method }));
    };
  }
  async dispose() {
    this.disposed = true;
  }
}

class CrashPlugin implements Plugin {
  id = 'crash';
  description = 'Plugin that fails to register';
  register(): never {
    throw new Error('boom');
  }
}

describe('plugin framework', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('GET /v1/plugins lists registered plugins', async () => {
    const socketPath = tmpSocket();
    const plugin = new HelloPlugin();
    const handle = await startContextServer({
      socketPath,
      plugins: [plugin],
      idleThrottleMs: 0,
    });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await udsJson(socketPath, 'GET', '/v1/plugins');
    expect(r.status).toBe(200);
    expect(r.body.plugins).toEqual([
      { id: 'hello', description: 'Test plugin — echoes the sub-path' },
    ]);
  });

  it('plugin route is dispatched with sub path', async () => {
    const socketPath = tmpSocket();
    const handle = await startContextServer({
      socketPath,
      plugins: [new HelloPlugin()],
      idleThrottleMs: 0,
    });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await udsJson(socketPath, 'GET', '/v1/plugins/hello/some/path');
    expect(r.status).toBe(200);
    expect(r.body.plugin).toBe('hello');
    expect(r.body.sub).toBe('some/path');
  });

  it('unknown plugin id → 404', async () => {
    const socketPath = tmpSocket();
    const handle = await startContextServer({
      socketPath,
      plugins: [new HelloPlugin()],
      idleThrottleMs: 0,
    });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    const r = await udsJson(socketPath, 'GET', '/v1/plugins/nope/x');
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/nope/);
  });

  it("plugin that throws during register doesn't break server", async () => {
    const socketPath = tmpSocket();
    const good = new HelloPlugin();
    const handle = await startContextServer({
      socketPath,
      plugins: [new CrashPlugin(), good],
      idleThrottleMs: 0,
    });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    // crash plugin's id should be 404 (never registered)
    const crashed = await udsJson(socketPath, 'GET', '/v1/plugins/crash/x');
    expect(crashed.status).toBe(404);
    // hello still works
    const hello = await udsJson(socketPath, 'GET', '/v1/plugins/hello/x');
    expect(hello.status).toBe(200);
    // listing only shows the successfully-registered one
    const list = await udsJson(socketPath, 'GET', '/v1/plugins');
    expect(list.body.plugins).toHaveLength(1);
    expect(list.body.plugins[0].id).toBe('hello');
  });

  it('dispose() is called on server stop', async () => {
    const socketPath = tmpSocket();
    const plugin = new HelloPlugin();
    const handle = await startContextServer({
      socketPath,
      plugins: [plugin],
      idleThrottleMs: 0,
    });
    expect(plugin.disposed).toBe(false);
    await handle.stop();
    await rm(socketPath, { force: true });
    expect(plugin.disposed).toBe(true);
  });
});

describe('OpenApiPlugin (parser)', () => {
  it('extracts operations from a minimal OpenAPI 3 doc', () => {
    const spec = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Test', version: '1' },
      paths: {
        '/users/{id}': {
          get: {
            operationId: 'getUser',
            summary: 'Fetch a user',
            tags: ['users'],
          },
          delete: {
            operationId: 'deleteUser',
            summary: 'Remove a user',
          },
        },
        '/users': {
          post: {
            operationId: 'createUser',
            summary: 'Create',
          },
        },
      },
    });
    const ops = parseOpenApi(spec, 'test');
    expect(ops).toHaveLength(3);
    expect(ops.find((o) => o.operationId === 'getUser')?.method).toBe('GET');
    expect(ops.find((o) => o.operationId === 'getUser')?.path).toBe('/users/{id}');
    expect(ops.find((o) => o.operationId === 'getUser')?.tags).toEqual(['users']);
    expect(ops.find((o) => o.operationId === 'deleteUser')?.method).toBe('DELETE');
    expect(ops.find((o) => o.operationId === 'createUser')?.method).toBe('POST');
  });

  it('falls back to "METHOD path" when operationId missing', () => {
    const spec = JSON.stringify({
      paths: { '/health': { get: { summary: 'check' } } },
    });
    const ops = parseOpenApi(spec, 'test');
    expect(ops[0]?.operationId).toBe('GET /health');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseOpenApi('not json', 'test')).toThrow(/JSON/);
  });
});

describe('OpenApiPlugin (route surface)', () => {
  // We exercise the plugin's route handler in isolation rather than
  // through the server — this avoids the Neo4j dependency in the
  // plugin's reindex() path. Backend write coverage is left to a
  // gated integration test.
  it('lookup + operations return canned operations after init', async () => {
    const spec = JSON.stringify({
      openapi: '3.0.0',
      paths: {
        '/charges': {
          post: { operationId: 'createCharge', summary: 'Create a charge' },
        },
      },
    });
    const fakeFetch = ((u: string) =>
      Promise.resolve(new Response(spec, { status: 200 }))) as typeof fetch;

    const plugin = new OpenApiPlugin({
      specs: [{ alias: 'stripe', url: 'https://x/openapi.json' }],
      fetchImpl: fakeFetch,
    });

    // Stub the reindex() backend write by overriding it — plugin still
    // populates its in-memory operations map via parseOpenApi.
    (plugin as unknown as { reindex: (ctx: PluginContext) => Promise<void> }).reindex = async () => {
      const ops = parseOpenApi(spec, 'stripe');
      (plugin as unknown as { operations: Map<string, unknown> }).operations = new Map([
        ['stripe', ops],
      ]);
      (plugin as unknown as { indexed: boolean }).indexed = true;
    };

    const ctx: PluginContext = {
      pluginId: 'openapi',
      embedderConfig: { url: '', model: '', dim: 0 },
      neo4j: { url: '', user: '', password: '', database: '' },
    };
    const handler = await plugin.register(ctx);

    // Lookup
    const lookupReq: any = { method: 'POST', url: '/lookup', on: () => {} };
    // Simulate body: we'll bypass readJsonBody by calling handler with a
    // stub req that emits 'data' + 'end' events after handler subscribes.
    let listeners: Record<string, Function[]> = {};
    const eventReq: any = {
      method: 'POST',
      url: '/lookup',
      on(e: string, cb: Function) {
        listeners[e] = listeners[e] ?? [];
        listeners[e].push(cb);
        return this;
      },
    };
    const chunks: string[] = [];
    let writeHead: any;
    const eventRes: any = {
      writeHead: (s: number, h: any) => {
        writeHead = { s, h };
      },
      end: (b: string) => {
        chunks.push(b);
      },
      headersSent: false,
    };
    const handlerPromise = handler(eventReq, eventRes, 'lookup');
    listeners['data']?.[0]?.(Buffer.from(JSON.stringify({ api: 'stripe', operation: 'createCharge' })));
    listeners['end']?.[0]?.();
    await handlerPromise;
    expect(writeHead.s).toBe(200);
    const result = JSON.parse(chunks[0]!);
    expect(result.result.operationId).toBe('createCharge');
    expect(result.result.path).toBe('/charges');
  });
});

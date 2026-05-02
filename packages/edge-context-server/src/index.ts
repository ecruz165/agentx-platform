import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ContextServerOptions {
  socketPath: string;
}

export interface ContextServerHandle {
  stop(): Promise<void>;
}

/**
 * MVP-0: echo server. Records and reflects every request — no storage.
 * MVP-2+: replace with KuzuDB GraphRAG + tree-sitter ingest per
 * prd-edge-context-server. Decision #2 keeps MCP banned: this server
 * exposes REST/UDS only, never an MCP surface.
 *
 * Exposes endpoints under /v1/context/* per the PRD. v1 trust model:
 * socket file is mode 0600 (decision #5).
 */
export async function startContextServer(opts: ContextServerOptions): Promise<ContextServerHandle> {
  await mkdir(dirname(opts.socketPath), { recursive: true, mode: 0o700 });
  await unlink(opts.socketPath).catch(() => {});

  const server = createServer((req, res) => echo(req, res, 'context'));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socketPath, () => resolve());
  });

  await chmod(opts.socketPath, 0o600);

  return {
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(opts.socketPath).catch(() => {});
    },
  };
}

function echo(req: IncomingMessage, res: ServerResponse, service: string) {
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
      })
    );
  });
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

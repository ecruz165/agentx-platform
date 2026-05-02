import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export {
  spawnWorker,
  type SpawnRepoSpec,
  type WorkerSpawnSpec,
  type SpawnResult,
  type SpawnedWorktree,
} from './spawn-worker.ts';

export interface HarnessServerOptions {
  socketPath: string;
}

export interface HarnessServerHandle {
  stop(): Promise<void>;
}

/**
 * MVP-1 minimal job registry on top of the echo behavior.
 *
 *   POST /v1/jobs          → echo body + remember it (in-memory, restart-volatile).
 *   GET  /v1/jobs          → { ok, service, jobs: [...] }
 *   GET  /v1/jobs/:id      → { ok, service, job: {...} }  or  404 { ok: false }
 *   anything else          → default echo
 *
 * MVP-3+ replaces this with LangGraph-driven orchestration + Postgres-persisted
 * job state per prd-harness-server.md. Keeping the registry in-memory now means
 * the TUI's "active jobs" view has something to render without committing to a
 * persistence story.
 *
 * v1 trust model unchanged: UDS socket at mode 0600 (decision #5) gates everything.
 */
const jobs = new Map<string, Record<string, unknown> & { jobId: string; submittedAt?: string; status?: string }>();

export async function startHarnessServer(opts: HarnessServerOptions): Promise<HarnessServerHandle> {
  await mkdir(dirname(opts.socketPath), { recursive: true, mode: 0o700 });
  await unlink(opts.socketPath).catch(() => {});

  const server = createServer((req, res) => route(req, res));

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

function route(req: IncomingMessage, res: ServerResponse) {
  let body = '';
  req.on('data', (c) => (body += c.toString()));
  req.on('end', () => {
    const service = 'harness';
    const url = (req.url ?? '/').split('?')[0]!.replace(/\/$/, '') || '/';
    const parsed = body ? safeJson(body) : null;

    // POST /v1/jobs — store + echo
    if (req.method === 'POST' && url === '/v1/jobs' && parsed && typeof parsed === 'object') {
      const job = parsed as Record<string, unknown> & { jobId?: string };
      if (typeof job.jobId === 'string') {
        jobs.set(job.jobId, {
          ...job,
          jobId: job.jobId,
          status: 'received',
          submittedAt: typeof job.submittedAt === 'string' ? job.submittedAt : new Date().toISOString(),
        });
      }
      ok(res, { service, method: req.method, path: req.url, body: parsed, ts: new Date().toISOString() });
      return;
    }

    // GET /v1/jobs — list summaries (newest first)
    if (req.method === 'GET' && url === '/v1/jobs') {
      const list = [...jobs.values()].reverse();
      ok(res, { service, jobs: list, count: list.length, ts: new Date().toISOString() });
      return;
    }

    // GET /v1/jobs/:id — single job detail
    if (req.method === 'GET' && url.startsWith('/v1/jobs/')) {
      const id = url.slice('/v1/jobs/'.length);
      const job = jobs.get(id);
      if (!job) {
        notFound(res, `job not found: ${id}`);
        return;
      }
      ok(res, { service, job, ts: new Date().toISOString() });
      return;
    }

    // Everything else — default echo
    ok(res, {
      service,
      method: req.method,
      path: req.url,
      body: parsed,
      ts: new Date().toISOString(),
    });
  });
}

function ok(res: ServerResponse, payload: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, ...payload }));
}

function notFound(res: ServerResponse, error: string): void {
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error }));
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

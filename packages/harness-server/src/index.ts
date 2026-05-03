import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  findPipeline,
  type AdapterId,
  type AgentDef,
  type PipelineCatalog,
} from './catalog.ts';
import type { CredentialBroker } from '@agentx/auth-lib';
import type { AgentStatus, JobRecord, RegisteredAgent } from './job.ts';
import { JobBus, type Envelope } from './job-bus.ts';
import { runJob, type AdapterFactory } from './orchestrator.ts';

export {
  spawnWorker,
  type SpawnRepoSpec,
  type WorkerSpawnSpec,
  type SpawnResult,
  type SpawnedWorktree,
} from './spawn-worker.ts';

export { JobBus, bridgeAdapter, type Envelope } from './job-bus.ts';
export {
  loadCatalog,
  findPipeline,
  CatalogError,
  type PipelineCatalog,
  type PipelineDef,
  type AgentDef,
  type AdapterId,
} from './catalog.ts';
export { runJob, defaultAdapterFactory, type AdapterFactory } from './orchestrator.ts';

export interface HarnessServerOptions {
  socketPath: string;
  /** Inject a bus to share with the orchestrator. Defaults to a fresh one. */
  bus?: JobBus;
  /** Pipeline catalog for agent registration on submit. Defaults to empty. */
  catalog?: PipelineCatalog;
  /**
   * Credential broker. When provided, registered jobs are orchestrated
   * automatically — runJob fires after registration and walks the agent list.
   * When absent, jobs are registered but never executed (TUI sees pending agents).
   * Tests pass a broker + adapterFactory together to mock invocation.
   */
  broker?: CredentialBroker;
  /** Override adapter construction (testing / custom adapter pools). */
  adapterFactory?: AdapterFactory;
}

export interface HarnessServerHandle {
  bus: JobBus;
  catalog: PipelineCatalog;
  stop(): Promise<void>;
}

export type { AgentStatus, RegisteredAgent, JobRecord } from './job.ts';

/**
 * The synthetic coordinator agent prepended to every job's agent list.
 *
 * In MVP it's a placeholder — the coordinator's "decision" of which pipeline
 * to run is currently made client-side (the CLI passes the pipeline id in the
 * submit body). When the coordinator becomes a real LLM agent (per the
 * authority memory: "coordinator chooses, not designs"), its adapter binding
 * will move into config and this constant becomes the registration record
 * shape, not its source.
 */
const COORDINATOR_AGENT: AgentDef = {
  id: 'coordinator',
  role: 'Coordinator',
  adapter: 'claude-sdk',
};

export async function startHarnessServer(opts: HarnessServerOptions): Promise<HarnessServerHandle> {
  const bus = opts.bus ?? new JobBus();
  const catalog: PipelineCatalog = opts.catalog ?? { pipelines: [] };
  const jobs = new Map<string, JobRecord>();
  const ctx: ServerCtx = {
    bus,
    catalog,
    jobs,
    broker: opts.broker,
    adapterFactory: opts.adapterFactory,
  };

  await mkdir(dirname(opts.socketPath), { recursive: true, mode: 0o700 });
  await unlink(opts.socketPath).catch(() => {});

  const server = createServer((req, res) => route(req, res, ctx));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socketPath, () => resolve());
  });

  await chmod(opts.socketPath, 0o600);

  return {
    bus,
    catalog,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(opts.socketPath).catch(() => {});
    },
  };
}

interface ServerCtx {
  bus: JobBus;
  catalog: PipelineCatalog;
  jobs: Map<string, JobRecord>;
  broker?: CredentialBroker;
  adapterFactory?: AdapterFactory;
}

function route(req: IncomingMessage, res: ServerResponse, ctx: ServerCtx) {
  const service = 'harness';
  const url = (req.url ?? '/').split('?')[0]!.replace(/\/$/, '') || '/';

  // GET /v1/jobs/:id/events — SSE stream. No body to buffer; attach handler now.
  const eventsMatch = req.method === 'GET' && url.match(/^\/v1\/jobs\/([^/]+)\/events$/);
  if (eventsMatch) {
    streamJobEvents(req, res, eventsMatch[1]!, ctx.bus);
    return;
  }

  // GET /v1/jobs/:id/agents — registered agent list for a job
  const agentsMatch = req.method === 'GET' && url.match(/^\/v1\/jobs\/([^/]+)\/agents$/);
  if (agentsMatch) {
    const job = ctx.jobs.get(agentsMatch[1]!);
    if (!job) {
      notFound(res, `job not found: ${agentsMatch[1]}`);
      return;
    }
    ok(res, { service, jobId: job.jobId, agents: job.agents, ts: new Date().toISOString() });
    return;
  }

  let body = '';
  req.on('data', (c) => (body += c.toString()));
  req.on('end', () => {
    const parsed = body ? safeJson(body) : null;

    // POST /v1/jobs — register + store
    if (req.method === 'POST' && url === '/v1/jobs' && parsed && typeof parsed === 'object') {
      handleSubmitJob(res, parsed as Record<string, unknown>, ctx);
      return;
    }

    // GET /v1/jobs — list summaries (newest first)
    if (req.method === 'GET' && url === '/v1/jobs') {
      const list = [...ctx.jobs.values()].reverse();
      ok(res, { service, jobs: list, count: list.length, ts: new Date().toISOString() });
      return;
    }

    // GET /v1/jobs/:id — single job detail
    if (req.method === 'GET' && url.startsWith('/v1/jobs/')) {
      const id = url.slice('/v1/jobs/'.length);
      const job = ctx.jobs.get(id);
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

function handleSubmitJob(res: ServerResponse, body: Record<string, unknown>, ctx: ServerCtx) {
  const jobId = typeof body.jobId === 'string' ? body.jobId : null;
  const pipelineId = typeof body.pipeline === 'string' ? body.pipeline : null;

  if (!jobId) {
    badRequest(res, 'jobId is required');
    return;
  }

  let agents: RegisteredAgent[];
  if (pipelineId) {
    const pipeline = findPipeline(ctx.catalog, pipelineId);
    if (!pipeline) {
      const known = ctx.catalog.pipelines.map((p) => p.id);
      badRequest(res, `unknown pipeline "${pipelineId}". Known: ${known.join(', ') || '(none registered)'}`);
      return;
    }
    agents = [
      registeredFromDef(COORDINATOR_AGENT),
      ...pipeline.agents.map(registeredFromDef),
    ];
  } else {
    // Submit without a pipeline — register only the coordinator. Useful for
    // smoke tests; production submits should always carry a pipeline id.
    agents = [registeredFromDef(COORDINATOR_AGENT)];
  }

  const submittedAt =
    typeof body.submittedAt === 'string' ? body.submittedAt : new Date().toISOString();

  const job: JobRecord = {
    ...body,
    jobId,
    status: 'received',
    submittedAt,
    agents,
  };
  ctx.jobs.set(jobId, job);

  ok(res, {
    service: 'harness',
    method: 'POST',
    path: '/v1/jobs',
    body,
    job,
    ts: new Date().toISOString(),
  });

  // Kick off the orchestrator in the background — only if a broker is wired.
  // Without a broker we have no way to authenticate adapter calls, so we leave
  // jobs in `received` state with all agents `pending` (registration-only mode).
  if (ctx.broker) {
    const broker = ctx.broker;
    const adapterFactory = ctx.adapterFactory;
    queueMicrotask(() => {
      void runJob(jobId, {
        jobs: ctx.jobs,
        bus: ctx.bus,
        broker,
        adapterFactory,
      });
    });
  }
}

function registeredFromDef(def: AgentDef): RegisteredAgent {
  return {
    id: def.id,
    role: def.role,
    adapter: def.adapter,
    systemPrompt: def.systemPrompt,
    status: 'pending',
  };
}

/**
 * SSE-over-UDS stream for a job's events. The TUI / web UI / external system
 * keeps this connection open; every Envelope published onto the bus for `jobId`
 * arrives here as `data: <json>\n\n`.
 *
 * TODO(you): heartbeat policy. Right now there is no keepalive — long idle
 * periods may cause the client (or an intermediate proxy in a future TCP
 * deployment) to close the connection. Decisions:
 *
 *   1. Interval: 5s (snappy but chatty), 15s (typical SSE default), 30s+
 *      (lower CPU, higher risk of intermediate timeouts).
 *   2. Frame: SSE comment line `: heartbeat\n\n` (invisible to clients) vs
 *      a real `event: heartbeat` frame (visible, lets clients log liveness).
 *   3. Stale-write detection: if `res.write(...)` returns false repeatedly,
 *      the client is gone but Node hasn't fired `close` yet — disconnect
 *      after N consecutive backpressured writes? After a write timeout?
 *
 * Constraint: the heartbeat must not block the event loop and must be cleared
 * on `req.close` / `res.close`. ~5–10 lines including the interval setup.
 */
function streamJobEvents(req: IncomingMessage, res: ServerResponse, jobId: string, bus: JobBus): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  });
  res.write(': connected\n\n');

  const unsubscribe = bus.subscribe(jobId, (envelope: Envelope) => {
    res.write(`data: ${JSON.stringify(envelope)}\n\n`);
  });

  const cleanup = () => {
    unsubscribe();
    res.end();
  };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
}

function ok(res: ServerResponse, payload: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, ...payload }));
}

function notFound(res: ServerResponse, error: string): void {
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error }));
}

function badRequest(res: ServerResponse, error: string): void {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error }));
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  JobBus,
  findPipeline,
  findProduct,
  runJob,
  type AdapterFactory,
  type AdapterId,
  type AgentDef,
  type AgentStatus,
  type Catalog,
  type Envelope,
  type JobRecord,
  type PipelineCatalog,
  type ProductDef,
  type RegisteredAgent,
} from '@agentx/harness-core';
import type { BindingResolver, CredentialBroker } from '@agentx/agent-auth-lib';
import { randomUUID } from 'node:crypto';
import { spawnLoaderJob, type LoaderEvent } from './loader-spawn.ts';
import { inlineCatalogLoader } from './load-catalog.ts';

export {
  spawnWorker,
  type SpawnRepoSpec,
  type WorkerSpawnSpec,
  type SpawnResult,
  type SpawnedWorktree,
} from './spawn-worker.ts';

export {
  spawnLoaderJob,
  type LoaderSpawnSpec,
  type LoaderJobHandle,
  type LoaderEvent,
} from './loader-spawn.ts';

export {
  loadCatalogFromWorkspaceYaml,
  inlineCatalogLoader,
} from './load-catalog.ts';

// Re-export the harness-core surface so existing consumers (harness-cli,
// examples) that import from '@agentx/harness-server' keep working unchanged.
// New consumers should prefer importing from '@agentx/harness-core' directly.
export {
  JobBus,
  bridgeAdapter,
  loadCatalog,
  findPipeline,
  findProduct,
  validateUnifiedCatalog,
  CatalogError,
  runJob,
  defaultAdapterFactory,
  type Envelope,
  type Catalog,
  type PipelineCatalog,
  type PipelineDef,
  type ProductDef,
  type ContextSourceDef,
  type AgentDef,
  type AdapterId,
  type AdapterFactory,
} from '@agentx/harness-core';

export interface HarnessServerOptions {
  socketPath: string;
  /** Inject a bus to share with the orchestrator. Defaults to a fresh one. */
  bus?: JobBus;
  /**
   * @deprecated Use `loadCatalog` instead.
   *
   * Inline catalog for back-compat with existing tests + simple inline-
   * config callers. When set, treated as a one-shot loader. New code
   * should always use `loadCatalog` so the source can be a YAML file,
   * S3 object, or central Catalog HTTP fetch — operator's choice.
   */
  catalog?: PipelineCatalog;
  /**
   * Catalog loader. Called once at server startup; the resolved Catalog
   * (pipelines + products) is read-only for the lifetime of the server.
   * Failure to load fails server startup — no partial catalog operation.
   * Restart-to-refresh; v1.x will add a SIGHUP-style reload signal.
   */
  loadCatalog?: () => Promise<Catalog>;
  /**
   * Credential broker. When provided, registered jobs are orchestrated
   * automatically — runJob fires after registration and walks the agent list.
   * When absent, jobs are registered but never executed (TUI sees pending agents).
   * Tests pass a broker + adapterFactory together to mock invocation.
   */
  broker?: CredentialBroker;
  /** Override adapter construction (testing / custom adapter pools). */
  adapterFactory?: AdapterFactory;
  /**
   * Optional binding resolver. When provided AND an agent declares a
   * non-empty `accepts` list, the orchestrator routes through
   * resolver → bindingToAdapter instead of the legacy adapter-id factory.
   * Per memory `project_per_worker_model_subscription`. When absent,
   * agents fall back to the legacy `adapter` field even if `accepts` is
   * declared — backwards compat for catalogs ahead of the resolver.
   */
  resolver?: BindingResolver;
}

export interface HarnessServerHandle {
  bus: JobBus;
  catalog: Catalog;
  stop(): Promise<void>;
}

export type { AgentStatus, RegisteredAgent, JobRecord } from '@agentx/harness-core';

/**
 * Synthetic agents harness-server inserts around every pipelined job's
 * user-defined agents. Both are placeholders today — their adapter
 * bindings will move into config when they become real LLM-driven
 * agents. The shape (an entry in the registered-agent list) is what
 * matters for now: the orchestrator walks them like any other agent,
 * the TUI surfaces them, and pipelines can specialize via overrides
 * down the road.
 *
 * COORDINATOR_AGENT (prepended)
 * -----------------------------
 * Job entry. In v1 the coordinator's "decision" of which pipeline to
 * run is made client-side (the CLI passes the pipeline id). When this
 * becomes a real agent — per project_authority_model_jobs_pipelines:
 * "coordinator chooses, not designs" — it'll inspect the intent and
 * route to a registered pipeline.
 *
 * CHECKOUT_COORDINATOR_AGENT (appended)
 * -------------------------------------
 * Job exit. Symmetric to the entry coordinator. When the pipeline's
 * user-defined agents finish, this synthetic agent owns the post-job
 * lifecycle — per project_memory_promotes_to_context +
 * project_central_grounding_bidirectional:
 *   1. harvest edge-memory for this jobId
 *   2. distill into "what went well / didn't go well / lessons"
 *   3. load the distilled output into edge-context-server (`learned`
 *      source type, via the existing loader infrastructure)
 *   4. promote the new Learning nodes to central-context
 *   5. only after promotion succeeds, mark the job completed
 * v1: placeholder — same status as the entry coordinator. The hook
 * point is in the agent list so step (1)-(5) can layer on without
 * touching the orchestrator. Pipelines that want specialized
 * checkout can override via a `checkout` phase before this synthetic
 * agent runs.
 */
const COORDINATOR_AGENT: AgentDef = {
  id: 'coordinator',
  role: 'Coordinator',
  adapter: 'claude-sdk',
};

const CHECKOUT_COORDINATOR_AGENT: AgentDef = {
  id: 'checkout-coordinator',
  role: 'CheckoutCoordinator',
  adapter: 'claude-sdk',
};

export async function startHarnessServer(opts: HarnessServerOptions): Promise<HarnessServerHandle> {
  const bus = opts.bus ?? new JobBus();
  // Resolve the catalog at startup. Operators pick the source via
  // loadCatalog; the deprecated inline `catalog` field keeps working
  // by wrapping it in a one-shot loader. Either way the catalog is
  // read-only for the lifetime of this server instance.
  const loader =
    opts.loadCatalog ??
    (opts.catalog
      ? inlineCatalogLoader({ pipelines: opts.catalog.pipelines })
      : inlineCatalogLoader({ pipelines: [] }));
  let catalog: Catalog;
  try {
    catalog = await loader();
  } catch (err) {
    // Fail fast — never serve traffic with a partial catalog.
    throw new Error(
      `harness-server: catalog load failed at startup — ${(err as Error).message}`
    );
  }
  const jobs = new Map<string, JobRecord>();
  const ctx: ServerCtx = {
    bus,
    catalog,
    jobs,
    broker: opts.broker,
    adapterFactory: opts.adapterFactory,
    resolver: opts.resolver,
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
  catalog: Catalog;
  jobs: Map<string, JobRecord>;
  broker?: CredentialBroker;
  adapterFactory?: AdapterFactory;
  resolver?: BindingResolver;
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

  // ─── Read-only catalog routes ───────────────────────────────────
  // The catalog is loaded once at startup and immutable thereafter
  // (per the authority model — admins mutate via YAML/central Catalog,
  // not via runtime API). These routes are the read surface clients
  // use to discover what's available.
  if (req.method === 'GET' && url === '/v1/catalog/pipelines') {
    ok(res, {
      service,
      pipelines: ctx.catalog.pipelines,
      count: ctx.catalog.pipelines.length,
      ts: new Date().toISOString(),
    });
    return;
  }
  const pipelineMatch = req.method === 'GET' && url.match(/^\/v1\/catalog\/pipelines\/([^/]+)$/);
  if (pipelineMatch) {
    const found = findPipeline(ctx.catalog, pipelineMatch[1]!);
    if (!found) {
      notFound(res, `pipeline not found: ${pipelineMatch[1]}`);
      return;
    }
    ok(res, { service, pipeline: found, ts: new Date().toISOString() });
    return;
  }
  if (req.method === 'GET' && url === '/v1/catalog/products') {
    const products = ctx.catalog.products ?? [];
    ok(res, {
      service,
      products,
      count: products.length,
      ts: new Date().toISOString(),
    });
    return;
  }
  const productMatch = req.method === 'GET' && url.match(/^\/v1\/catalog\/products\/([^/]+)$/);
  if (productMatch) {
    const found = findProduct(ctx.catalog, productMatch[1]!);
    if (!found) {
      notFound(res, `product not found: ${productMatch[1]}`);
      return;
    }
    ok(res, { service, product: found, ts: new Date().toISOString() });
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

    // POST /v1/loader-jobs — spawn an agentx-load worker, register it as
    // a JobRecord, bridge its events onto the JobBus as 'loader-event'
    // adapter envelopes. Once registered, jobs-tui sees the loader in
    // GET /v1/jobs and the SSE stream picks up its progress envelopes.
    if (req.method === 'POST' && url === '/v1/loader-jobs' && parsed && typeof parsed === 'object') {
      void handleSubmitLoaderJob(res, parsed as Record<string, unknown>, ctx);
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
      registeredFromDef(CHECKOUT_COORDINATOR_AGENT),
    ];
  } else {
    // Submit without a pipeline — register only the entry coordinator.
    // Useful for smoke tests; production submits should always carry a
    // pipeline id. We omit checkout-coordinator here because there's no
    // pipeline output to consolidate.
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
    const resolver = ctx.resolver;
    queueMicrotask(() => {
      void runJob(jobId, {
        jobs: ctx.jobs,
        bus: ctx.bus,
        broker,
        adapterFactory,
        resolver,
      });
    });
  }
}

async function handleSubmitLoaderProductJobs(
  res: ServerResponse,
  body: Record<string, unknown>,
  productId: string,
  ctx: ServerCtx
): Promise<void> {
  const product = findProduct(ctx.catalog, productId);
  if (!product) {
    const known = (ctx.catalog.products ?? []).map((p) => p.id);
    badRequest(
      res,
      `unknown product '${productId}'. Known: ${known.join(', ') || '(none)'}`
    );
    return;
  }
  if (!product.contextSources || product.contextSources.length === 0) {
    badRequest(
      res,
      `product '${productId}' has no contextSources declared in the catalog`
    );
    return;
  }
  // Workspace-default fallbacks come from the request body. Per-source
  // overrides in the catalog (embedderUrl/embedderModel/backend) win.
  const defaultBackend = typeof body.backend === 'string' ? body.backend : undefined;
  const defaultEmbedderUrl =
    typeof body.embedderUrl === 'string' ? body.embedderUrl : undefined;
  const workspaceRoot =
    typeof body.workspaceRoot === 'string' ? body.workspaceRoot : null;
  if (!workspaceRoot) {
    badRequest(res, 'workspaceRoot is required for productId-form intent');
    return;
  }

  const submittedAt = new Date().toISOString();
  const spawnedJobIds: string[] = [];
  type QueuedSpec = Parameters<typeof handleSubmitLoaderSingleResolved>[0];
  const queue: QueuedSpec[] = [];
  for (const src of product.contextSources) {
    const backend = src.backend ?? defaultBackend;
    const embedderUrl = src.embedderUrl ?? defaultEmbedderUrl;
    if (!backend || !embedderUrl) {
      // Per-source missing required defaults — skip with a warning event
      // so the rest of the product still loads. We could fail-fast instead,
      // but partial load + reported errors gives the operator more signal
      // than an "all-or-nothing" failure.
      ctx.bus.publish(`product:${productId}`, 'loader', {
        kind: 'error',
        ts: new Date().toISOString(),
        message: `skipped ${src.type}/${src.target}: missing backend or embedder-url`,
      });
      continue;
    }
    // Each source becomes its own job. Short jobIds keep UDS paths under
    // the 104-byte sun_path limit.
    const jobId = `l-${randomUUID().slice(0, 8)}`;
    spawnedJobIds.push(jobId);
    queue.push({
      jobId,
      productId,
      target: resolveProductTarget(src.target, workspaceRoot),
      type: src.type,
      backend,
      backendUser:
        typeof body.backendUser === 'string' ? body.backendUser : undefined,
      backendPassword:
        typeof body.backendPassword === 'string' ? body.backendPassword : undefined,
      embedderUrl,
      embedderModel: src.embedderModel,
      embedderDim: src.embedderDim,
      workspaceRoot,
    });
  }

  // Pre-register all queued jobs as 'pending' so GET /v1/jobs reflects
  // the full set immediately. The actual loader spawns are serialized
  // below — concurrent embedder calls are the single most reliable way
  // to crash Docker Model Runner's llama.cpp slot scheduler, so we run
  // loaders one at a time within a product's fan-out.
  for (const spec of queue) {
    ctx.jobs.set(spec.jobId, {
      jobId: spec.jobId,
      name: `load: ${spec.type} (${spec.productId ?? '?'})`,
      productId: spec.productId,
      status: 'received',
      submittedAt,
      agents: [
        {
          id: 'loader',
          role: 'Loader',
          adapter: 'loader-spawn' as AdapterId,
          status: 'pending',
        },
      ],
    } as JobRecord);
  }

  ok(res, {
    service: 'harness',
    method: 'POST',
    path: '/v1/loader-jobs',
    productId,
    spawnedJobIds,
    count: spawnedJobIds.length,
    ts: submittedAt,
  });

  // Run the queue sequentially in the background. Errors surface as
  // per-job status transitions; the response above already told the
  // client which jobIds will run.
  void (async () => {
    for (const spec of queue) {
      try {
        await handleSubmitLoaderSingleResolved(spec, ctx);
      } catch {
        // handleSubmitLoaderSingleResolved already publishes an error
        // event + flips the job status; nothing more to do here.
      }
    }
  })();
}

/** OSS package targets like "react@18.2.0" stay as-is; URLs likewise.
 *  Bare paths get resolved against the workspace root so relative
 *  YAML entries like `./packages/foo` work consistently. */
function resolveProductTarget(target: string, workspaceRoot: string): string {
  if (target.startsWith('/') || target.includes('://')) return target;
  // Treat package@version specifiers as opaque
  if (/^[A-Za-z@][A-Za-z0-9_./@-]*@[A-Za-z0-9._-]+$/.test(target)) return target;
  // Relative path
  return `${workspaceRoot}/${target.replace(/^\.\//, '')}`;
}

interface ResolvedSingleSpec {
  jobId: string;
  productId?: string;
  target: string;
  type: string;
  backend: string;
  backendUser?: string;
  backendPassword?: string;
  embedderUrl: string;
  embedderModel?: string;
  embedderDim?: number;
  workspaceRoot: string;
}

/** Spawns one loader for a fully-resolved spec (used by both the direct
 *  single-source POST and the product fan-out path). */
async function handleSubmitLoaderSingleResolved(
  spec: ResolvedSingleSpec,
  ctx: ServerCtx
): Promise<void> {
  const submittedAt = new Date().toISOString();
  const loaderAgent: RegisteredAgent = {
    id: 'loader',
    role: 'Loader',
    adapter: 'loader-spawn' as AdapterId,
    status: 'running',
  };
  const job: JobRecord = {
    jobId: spec.jobId,
    name: spec.productId
      ? `load: ${spec.type} (${spec.productId})`
      : `load: ${spec.type}`,
    productId: spec.productId,
    status: 'running',
    submittedAt,
    agents: [loaderAgent],
  } as JobRecord;
  ctx.jobs.set(spec.jobId, job);

  const counts = {
    files: 0,
    chunks: 0,
    nodes: 0,
    edges: 0,
    vectors: 0,
    errors: 0,
  };

  let handle: Awaited<ReturnType<typeof spawnLoaderJob>>;
  try {
    handle = await spawnLoaderJob({
      jobId: spec.jobId,
      target: spec.target,
      type: spec.type,
      backend: spec.backend,
      backendUser: spec.backendUser,
      backendPassword: spec.backendPassword,
      embedderUrl: spec.embedderUrl,
      embedderModel: spec.embedderModel,
      embedderDim: spec.embedderDim,
      workspaceRoot: spec.workspaceRoot,
      tmuxPane: process.env.TMUX
        ? { session: process.env.AGENTX_TMUX_SESSION ?? 'agentx', window: 'loaders' }
        : undefined,
    });
  } catch (err) {
    job.status = 'failed';
    loaderAgent.status = 'failed';
    ctx.bus.publish(spec.jobId, 'loader', {
      kind: 'error',
      ts: new Date().toISOString(),
      message: `loader failed to start: ${(err as Error).message}`,
    });
    return;
  }

  handle.subscribe((event: LoaderEvent) => {
    switch (event.kind) {
      case 'item-walked':
        counts.files++;
        break;
      case 'chunk-produced':
        counts.chunks += Number(event.chunkCount ?? 0);
        break;
      case 'node-written':
        counts.nodes++;
        break;
      case 'edge-written':
        counts.edges++;
        break;
      case 'chunk-embedded':
        counts.vectors++;
        break;
      case 'error':
        counts.errors++;
        break;
    }
    const lastItem = typeof event.itemId === 'string' ? event.itemId : undefined;
    ctx.bus.publish(spec.jobId, 'loader', {
      kind: 'loader-event',
      ts: new Date().toISOString(),
      counts: { ...counts },
      lastItem,
      innerKind: event.kind,
    });
  });

  try {
    await handle.whenComplete;
    job.status = 'completed';
    loaderAgent.status = 'completed';
  } catch (err) {
    job.status = 'failed';
    loaderAgent.status = 'failed';
    ctx.bus.publish(spec.jobId, 'loader', {
      kind: 'error',
      ts: new Date().toISOString(),
      message: `loader job ended: ${(err as Error).message}`,
    });
  }
}

async function handleSubmitLoaderJob(
  res: ServerResponse,
  body: Record<string, unknown>,
  ctx: ServerCtx
): Promise<void> {
  // Two acceptance shapes:
  //   1. {productId, ...defaults} — server resolves from catalog and
  //      fans out one worker per declared contextSource. Client doesn't
  //      need to know what sources exist.
  //   2. {jobId, target, type, backend, embedderUrl, workspaceRoot} —
  //      ad-hoc single-source intent (matches what harness-cli's
  //      single-target form sends today).
  const productId = typeof body.productId === 'string' ? body.productId : null;
  if (productId) {
    return handleSubmitLoaderProductJobs(res, body, productId, ctx);
  }

  const jobId = typeof body.jobId === 'string' ? body.jobId : null;
  const target = typeof body.target === 'string' ? body.target : null;
  const type = typeof body.type === 'string' ? body.type : null;
  const backend = typeof body.backend === 'string' ? body.backend : null;
  const embedderUrl = typeof body.embedderUrl === 'string' ? body.embedderUrl : null;
  const workspaceRoot =
    typeof body.workspaceRoot === 'string' ? body.workspaceRoot : null;

  if (!jobId || !target || !type || !backend || !embedderUrl || !workspaceRoot) {
    badRequest(
      res,
      'either {productId, ...} or {jobId, target, type, backend, embedderUrl, workspaceRoot} required'
    );
    return;
  }

  // Register the loader as a single-agent job up-front so GET /v1/jobs
  // sees it immediately. The synthetic 'loader' agent is the bridge from
  // the loader's IngestionEvent stream onto the JobBus — there's no real
  // agent process behind it, just our event adapter.
  const submittedAt = new Date().toISOString();
  const loaderAgent: RegisteredAgent = {
    id: 'loader',
    role: 'Loader',
    adapter: 'loader-spawn' as AdapterId,
    status: 'running',
  };
  const job: JobRecord = {
    jobId,
    name: typeof body.name === 'string' ? body.name : `load: ${type}`,
    productId: typeof body.productId === 'string' ? body.productId : undefined,
    status: 'running',
    submittedAt,
    agents: [loaderAgent],
  } as JobRecord;
  ctx.jobs.set(jobId, job);

  // Respond to the client immediately — they asked to start a job, not to
  // block until it finishes. The client polls /v1/jobs/:id or subscribes
  // to /v1/jobs/:id/events for progress.
  ok(res, {
    service: 'harness',
    method: 'POST',
    path: '/v1/loader-jobs',
    body,
    job,
    ts: submittedAt,
  });

  // Counters tracked across all incoming LoaderEvents — published onto
  // the JobBus on every event so the TUI's SSE consumer sees a smooth
  // running total instead of having to replay+aggregate the raw stream.
  const counts = {
    files: 0,
    chunks: 0,
    nodes: 0,
    edges: 0,
    vectors: 0,
    errors: 0,
  };

  let handle: Awaited<ReturnType<typeof spawnLoaderJob>>;
  try {
    handle = await spawnLoaderJob({
      jobId,
      target,
      type,
      backend,
      backendUser: typeof body.backendUser === 'string' ? body.backendUser : undefined,
      backendPassword:
        typeof body.backendPassword === 'string' ? body.backendPassword : undefined,
      embedderUrl,
      embedderModel:
        typeof body.embedderModel === 'string' ? body.embedderModel : undefined,
      embedderDim:
        typeof body.embedderDim === 'number' ? body.embedderDim : undefined,
      workspaceRoot,
      // Auto-tmux: if the harness-server itself was started inside a
      // tmux session, spawn each loader in its own pane in the
      // `loaders` window. The harness-cli that submitted this intent
      // also sets this option when called from tmux; this is the
      // belt-and-suspenders path for when the *server* runs in tmux
      // but the submit comes from a different process (cron, web UI).
      tmuxPane:
        typeof body.tmuxPane === 'object' && body.tmuxPane !== null
          ? (body.tmuxPane as { session: string; window: string })
          : process.env.TMUX
            ? { session: process.env.AGENTX_TMUX_SESSION ?? 'agentx', window: 'loaders' }
            : undefined,
    });
  } catch (err) {
    job.status = 'failed';
    loaderAgent.status = 'failed';
    ctx.bus.publish(jobId, 'loader', {
      kind: 'error',
      ts: new Date().toISOString(),
      message: `loader failed to start: ${(err as Error).message}`,
    });
    return;
  }

  handle.subscribe((event: LoaderEvent) => {
    switch (event.kind) {
      case 'item-walked':
        counts.files++;
        break;
      case 'chunk-produced':
        counts.chunks += Number(event.chunkCount ?? 0);
        break;
      case 'node-written':
        counts.nodes++;
        break;
      case 'edge-written':
        counts.edges++;
        break;
      case 'chunk-embedded':
        counts.vectors++;
        break;
      case 'error':
        counts.errors++;
        break;
    }
    const lastItem =
      typeof event.itemId === 'string' ? event.itemId : undefined;
    ctx.bus.publish(jobId, 'loader', {
      kind: 'loader-event',
      ts: new Date().toISOString(),
      counts: { ...counts },
      lastItem,
      innerKind: event.kind,
    });
  });

  try {
    await handle.whenComplete;
    job.status = 'completed';
    loaderAgent.status = 'completed';
  } catch (err) {
    job.status = 'failed';
    loaderAgent.status = 'failed';
    ctx.bus.publish(jobId, 'loader', {
      kind: 'error',
      ts: new Date().toISOString(),
      message: `loader job ended: ${(err as Error).message}`,
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
    config: def.config,
    accepts: def.accepts,
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

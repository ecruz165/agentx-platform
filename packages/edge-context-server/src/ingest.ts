/**
 * Ingestion service — turns the four PRD intake paths (§ 4.1.5) into a
 * server surface. v1 implements:
 *
 *   - REPO   (F21) — git or local; tree-sitter via context-loader-core.
 *   - UPLOAD (F22, F23) — file → local FS + Doc node.
 *
 * Crawl (F26) and external-source (F24) are interfaces only here; their
 * implementations land in follow-up slices.
 *
 * Concurrency model:
 *   - In-memory map of ingestId → status. No persistence in v1; a
 *     server restart loses in-flight ingests (consumers retry).
 *   - One background task per ingest, tracked via Promise; events are
 *     buffered AND broadcast to live subscribers (WebSocket /v1/ingest/events).
 *   - Cooperative cancel via AbortSignal — caller can cancel by ingestId.
 *
 * Per-product isolation (F1):
 *   - Each ingest carries `productId`; the IngestService ensures the
 *     per-product Neo4j database exists (CREATE DATABASE IF NOT EXISTS
 *     <productId>) before kicking off the ingest. Default is the driver's
 *     default DB (typically 'neo4j') when productId is absent — keeps the
 *     v0 single-DB workflow working.
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type EmbedderConfig,
  type IngestionEvent,
  type IngestionSummary,
  Neo4jBackend,
  ingest,
} from '@ecruz165/context-loader-core';
import neo4j, { type Driver } from 'neo4j-driver';
import { Crawler, type CrawlRequest, type CrawlScope } from './crawl.ts';
import { createHttpEmbedderClient } from '@ecruz165/context-loader-core';
import {
  ConfluenceFetcher,
  type ConfluenceIngestRequest,
  type ExternalSourceFetcher,
  GithubIssuesFetcher,
  type GithubIssuesIngestRequest,
  JiraFetcher,
  type JiraIngestRequest,
  runConfluenceIngest,
  runGithubIssuesIngest,
  runJiraIngest,
} from './external-sources.ts';

export interface IngestServiceOptions {
  /** Bolt URL — same one ContextQueryService uses. */
  neo4jUrl: string;
  neo4jUser?: string;
  neo4jPassword: string;
  /** Default database when productId not supplied. */
  defaultDatabase?: string;
  /** Embedder config passed to context-loader-core's ingest(). */
  embedder: EmbedderConfig;
  /** Override the GitHub Issues fetcher — tests inject a stub. */
  githubIssuesFetcher?: ExternalSourceFetcher;
  /** Override the Jira fetcher — tests inject a stub. */
  jiraFetcher?: JiraFetcher;
  /** Override the Confluence fetcher — tests inject a stub. */
  confluenceFetcher?: ConfluenceFetcher;
  /** Where /v1/ingest/upload writes files (F23). Default: <CWD>/.harness/context-uploads. */
  uploadsDir?: string;
}

export type RepoSource =
  | { type: 'local'; path: string }
  | { type: 'git'; cloneUrl: string; branch?: string };

export interface RepoIngestRequest {
  /** Caller-meaningful name for the repo (used in event metadata). */
  name: string;
  source: RepoSource;
  /** Source type id (default 'code-full'). */
  sourceTypeId?: string;
  /** Per-product graph isolation (F1). When set, ingest writes to the
   *  Neo4j database named <productId>. */
  productId?: string;
}

export interface CrawlIngestRequest {
  /** Caller-meaningful name for the crawl run. */
  name: string;
  /** Starting URL — for 'page' scope this is the only URL fetched.
   *  For 'subtree' / 'site' scopes BFS continues from here. */
  url: string;
  /** Crawl breadth. Default 'page'. */
  scope?: CrawlScope;
  /** Hop count cap for subtree/site BFS. Default 3. */
  maxDepth?: number;
  /** Total page cap (safety). Default 100. */
  maxPages?: number;
  /** Defense-in-depth host allowlist. */
  allowedDomains?: string[];
  productId?: string;
  /** Per-host rate limit (req/sec). Default 1. */
  rateLimitPerHost?: number;
  /** Caller-supplied previous ETag for incremental refresh — applies
   *  to the start URL only in v1. */
  ifNoneMatch?: string;
  /** Caller-supplied previous Last-Modified for incremental refresh —
   *  applies to the start URL only in v1. */
  ifModifiedSince?: string;
}

export interface UploadIngestRequest {
  /** Original filename (used in node properties + on-disk path). */
  filename: string;
  /** MIME type — drives the embedding strategy. */
  contentType?: string;
  /** Caller-supplied description for the Doc node. */
  description?: string;
  productId?: string;
  /** Raw bytes. v1 reads the whole upload into memory; the 50MB cap
   *  (PRD CS11 lean) is enforced by the route handler. */
  bytes: Uint8Array;
}

export type IngestState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface IngestStatus {
  ingestId: string;
  kind: 'repo' | 'upload' | 'crawl' | 'github-issues' | 'jira' | 'confluence';
  state: IngestState;
  startedAt: string;
  completedAt?: string;
  /** Populated on completed/failed. */
  summary?: IngestionSummary;
  error?: string;
  /** Per-product DB this ingest targeted. */
  productId?: string;
  /** Buffer of all events emitted so far — WS subscribers can replay
   *  history when they connect mid-run. Capped at 1000 entries; older
   *  events are dropped (still flagged via 'event-overflow'). */
  events: IngestionEvent[];
}

export interface UploadEntry {
  docId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
  localPath: string;
  productId?: string;
  description?: string;
}

export type EventCallback = (e: IngestionEvent) => void;

export interface IngestService {
  startRepoIngest(req: RepoIngestRequest): Promise<{ ingestId: string }>;
  startUploadIngest(req: UploadIngestRequest): Promise<{ ingestId: string; entry: UploadEntry }>;
  startCrawlIngest(req: CrawlIngestRequest): Promise<{ ingestId: string }>;
  startGithubIssuesIngest(req: GithubIssuesIngestRequest): Promise<{ ingestId: string }>;
  startJiraIngest(req: JiraIngestRequest): Promise<{ ingestId: string }>;
  startConfluenceIngest(req: ConfluenceIngestRequest): Promise<{ ingestId: string }>;
  getIngest(ingestId: string): IngestStatus | undefined;
  listIngests(): IngestStatus[];
  cancelIngest(ingestId: string): boolean;
  /** Subscribe to live events for a given ingest; returns an unsubscribe fn. */
  subscribe(ingestId: string, cb: EventCallback): () => void;
  listUploads(productId?: string): Promise<UploadEntry[]>;
  deleteUpload(docId: string): Promise<boolean>;
  close(): Promise<void>;
}

const EVENT_BUFFER_MAX = 1000;
const SAFE_DB_NAME = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/i;

export class ContextIngestService implements IngestService {
  private readonly driver: Driver;
  private readonly defaultDatabase: string;
  private readonly embedder: EmbedderConfig;
  private readonly uploadsDir: string;
  private readonly opts: IngestServiceOptions;
  private readonly ingests = new Map<string, IngestStatus>();
  private readonly subscribers = new Map<string, Set<EventCallback>>();
  private readonly cancellers = new Map<string, AbortController>();
  /** Records DBs we've already ensured this process — avoids hammering
   *  CREATE DATABASE IF NOT EXISTS on every ingest. */
  private readonly ensuredDbs = new Set<string>();
  private readonly uploadsByDocId = new Map<string, UploadEntry>();
  private readonly crawler = new Crawler();
  private readonly githubIssuesFetcher: ExternalSourceFetcher;
  private readonly jiraFetcher: JiraFetcher;
  private readonly confluenceFetcher: ConfluenceFetcher;

  constructor(opts: IngestServiceOptions) {
    this.opts = opts;
    this.githubIssuesFetcher = opts.githubIssuesFetcher ?? new GithubIssuesFetcher();
    this.jiraFetcher = opts.jiraFetcher ?? new JiraFetcher();
    this.confluenceFetcher = opts.confluenceFetcher ?? new ConfluenceFetcher();
    this.driver = neo4j.driver(
      opts.neo4jUrl,
      neo4j.auth.basic(opts.neo4jUser ?? 'neo4j', opts.neo4jPassword),
    );
    this.defaultDatabase = opts.defaultDatabase ?? 'neo4j';
    this.embedder = opts.embedder;
    this.uploadsDir = opts.uploadsDir ?? join(process.cwd(), '.harness', 'context-uploads');
  }

  async close(): Promise<void> {
    // Cancel everything in flight before tearing down the driver.
    for (const c of this.cancellers.values()) c.abort();
    await this.driver.close();
  }

  async startRepoIngest(req: RepoIngestRequest): Promise<{ ingestId: string }> {
    const ingestId = newIngestId();
    const status: IngestStatus = {
      ingestId,
      kind: 'repo',
      state: 'pending',
      startedAt: new Date().toISOString(),
      productId: req.productId,
      events: [],
    };
    this.ingests.set(ingestId, status);

    const controller = new AbortController();
    this.cancellers.set(ingestId, controller);

    // Fire-and-forget; status updates happen via the Promise's result.
    void this.runRepoIngest(ingestId, req, controller.signal).catch((err: Error) => {
      this.transitionFailed(ingestId, err.message);
    });

    return { ingestId };
  }

  async startGithubIssuesIngest(
    req: GithubIssuesIngestRequest,
  ): Promise<{ ingestId: string }> {
    const ingestId = newIngestId();
    const status: IngestStatus = {
      ingestId,
      kind: 'github-issues',
      state: 'pending',
      startedAt: new Date().toISOString(),
      productId: req.productId,
      events: [],
    };
    this.ingests.set(ingestId, status);

    const controller = new AbortController();
    this.cancellers.set(ingestId, controller);

    void this.runGithubIssuesIngest(ingestId, req, controller.signal).catch((err: Error) => {
      this.transitionFailed(ingestId, err.message);
    });

    return { ingestId };
  }

  async startJiraIngest(req: JiraIngestRequest): Promise<{ ingestId: string }> {
    const ingestId = newIngestId();
    this.ingests.set(ingestId, {
      ingestId,
      kind: 'jira',
      state: 'pending',
      startedAt: new Date().toISOString(),
      productId: req.productId,
      events: [],
    });
    const controller = new AbortController();
    this.cancellers.set(ingestId, controller);
    void this.runJiraIngest(ingestId, req, controller.signal).catch((err: Error) => {
      this.transitionFailed(ingestId, err.message);
    });
    return { ingestId };
  }

  async startConfluenceIngest(req: ConfluenceIngestRequest): Promise<{ ingestId: string }> {
    const ingestId = newIngestId();
    this.ingests.set(ingestId, {
      ingestId,
      kind: 'confluence',
      state: 'pending',
      startedAt: new Date().toISOString(),
      productId: req.productId,
      events: [],
    });
    const controller = new AbortController();
    this.cancellers.set(ingestId, controller);
    void this.runConfluenceIngest(ingestId, req, controller.signal).catch((err: Error) => {
      this.transitionFailed(ingestId, err.message);
    });
    return { ingestId };
  }

  async startCrawlIngest(req: CrawlIngestRequest): Promise<{ ingestId: string }> {
    const ingestId = newIngestId();
    const status: IngestStatus = {
      ingestId,
      kind: 'crawl',
      state: 'pending',
      startedAt: new Date().toISOString(),
      productId: req.productId,
      events: [],
    };
    this.ingests.set(ingestId, status);

    const controller = new AbortController();
    this.cancellers.set(ingestId, controller);

    void this.runCrawlIngest(ingestId, req, controller.signal).catch((err: Error) => {
      this.transitionFailed(ingestId, err.message);
    });

    return { ingestId };
  }

  async startUploadIngest(
    req: UploadIngestRequest,
  ): Promise<{ ingestId: string; entry: UploadEntry }> {
    const ingestId = newIngestId();
    const docId = `doc_${ingestId.slice(4)}`;
    const safeName = req.filename.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 200);
    const docDir = join(this.uploadsDir, docId);
    await mkdir(docDir, { recursive: true, mode: 0o700 });
    const localPath = join(docDir, safeName);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(localPath, req.bytes, { mode: 0o600 });

    const entry: UploadEntry = {
      docId,
      filename: req.filename,
      contentType: req.contentType ?? 'application/octet-stream',
      sizeBytes: req.bytes.byteLength,
      uploadedAt: new Date().toISOString(),
      localPath,
      productId: req.productId,
      description: req.description,
    };
    this.uploadsByDocId.set(docId, entry);

    const status: IngestStatus = {
      ingestId,
      kind: 'upload',
      state: 'pending',
      startedAt: new Date().toISOString(),
      productId: req.productId,
      events: [],
    };
    this.ingests.set(ingestId, status);

    void this.runUploadIngest(ingestId, entry).catch((err: Error) => {
      this.transitionFailed(ingestId, err.message);
    });

    return { ingestId, entry };
  }

  getIngest(ingestId: string): IngestStatus | undefined {
    return this.ingests.get(ingestId);
  }

  listIngests(): IngestStatus[] {
    return [...this.ingests.values()].sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    );
  }

  cancelIngest(ingestId: string): boolean {
    const controller = this.cancellers.get(ingestId);
    if (!controller) return false;
    controller.abort();
    const status = this.ingests.get(ingestId);
    if (status && (status.state === 'pending' || status.state === 'running')) {
      status.state = 'cancelled';
      status.completedAt = new Date().toISOString();
    }
    return true;
  }

  subscribe(ingestId: string, cb: EventCallback): () => void {
    let subs = this.subscribers.get(ingestId);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(ingestId, subs);
    }
    subs.add(cb);
    return () => {
      subs?.delete(cb);
      if (subs && subs.size === 0) this.subscribers.delete(ingestId);
    };
  }

  async listUploads(productId?: string): Promise<UploadEntry[]> {
    const all = [...this.uploadsByDocId.values()];
    return productId ? all.filter((u) => u.productId === productId) : all;
  }

  async deleteUpload(docId: string): Promise<boolean> {
    const entry = this.uploadsByDocId.get(docId);
    if (!entry) return false;
    await rm(join(this.uploadsDir, docId), { recursive: true, force: true });
    this.uploadsByDocId.delete(docId);

    // Remove the Doc node + embeddings from the graph (best-effort —
    // never block the API on a graph delete).
    const db = await this.resolveDatabase(entry.productId);
    const session = this.driver.session({ database: db });
    try {
      await session.run(`MATCH (n {id: $id}) DETACH DELETE n`, { id: docId });
    } catch {
      // ignore — entry is gone from the index regardless
    } finally {
      await session.close();
    }
    return true;
  }

  // ─── private: actual work ────────────────────────────────────────────

  private async runRepoIngest(
    ingestId: string,
    req: RepoIngestRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const status = this.must(ingestId);
    status.state = 'running';

    let workDir: string | null = null;
    let cleanupGitClone = false;
    try {
      // 1. Resolve source to a local path. Git → shallow clone to tmp.
      if (req.source.type === 'local') {
        workDir = req.source.path;
      } else {
        workDir = await mkdtemp(join(tmpdir(), `edge-context-clone-${ingestId.slice(4)}-`));
        cleanupGitClone = true;
        await runGitClone(req.source.cloneUrl, req.source.branch, workDir, signal);
      }

      // 2. Ensure per-product DB exists.
      const database = await this.resolveDatabase(req.productId);

      // 3. Construct the IngestSpec + run.
      const backend = new Neo4jBackend({
        url: this.opts.neo4jUrl,
        user: this.opts.neo4jUser ?? 'neo4j',
        password: this.opts.neo4jPassword,
        database,
        vectorDim: this.embedder.dim,
      });
      try {
        const summary = await ingest({
          source: {
            type: req.sourceTypeId ?? 'code-full',
            ref: { kind: 'path', path: workDir },
          },
          backend,
          embedder: this.embedder,
          signal,
          onEvent: (e) => this.emit(ingestId, e),
        });
        this.transitionCompleted(ingestId, summary);
      } finally {
        await backend.close();
      }
    } catch (err) {
      if (signal.aborted) {
        // already transitioned to cancelled by cancelIngest()
        return;
      }
      throw err;
    } finally {
      if (cleanupGitClone && workDir) {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  private async runGithubIssuesIngest(
    ingestId: string,
    req: GithubIssuesIngestRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const status = this.must(ingestId);
    status.state = 'running';

    const database = await this.resolveDatabase(req.productId);
    const backend = new Neo4jBackend({
      url: this.opts.neo4jUrl,
      user: this.opts.neo4jUser ?? 'neo4j',
      password: this.opts.neo4jPassword,
      database,
      vectorDim: this.embedder.dim,
    });
    try {
      const summary = await runGithubIssuesIngest({
        fetcher: this.githubIssuesFetcher,
        backend,
        embedderConfig: this.embedder,
        request: req,
        signal,
        onEvent: (e) => this.emit(ingestId, e),
      });
      this.transitionCompleted(ingestId, summary);
    } finally {
      await backend.close();
    }
  }

  private async runJiraIngest(
    ingestId: string,
    req: JiraIngestRequest,
    signal: AbortSignal,
  ): Promise<void> {
    this.must(ingestId).state = 'running';
    const database = await this.resolveDatabase(req.productId);
    const backend = new Neo4jBackend({
      url: this.opts.neo4jUrl,
      user: this.opts.neo4jUser ?? 'neo4j',
      password: this.opts.neo4jPassword,
      database,
      vectorDim: this.embedder.dim,
    });
    try {
      const summary = await runJiraIngest({
        fetcher: this.jiraFetcher,
        backend,
        embedderConfig: this.embedder,
        request: req,
        signal,
        onEvent: (e) => this.emit(ingestId, e),
      });
      this.transitionCompleted(ingestId, summary);
    } finally {
      await backend.close();
    }
  }

  private async runConfluenceIngest(
    ingestId: string,
    req: ConfluenceIngestRequest,
    signal: AbortSignal,
  ): Promise<void> {
    this.must(ingestId).state = 'running';
    const database = await this.resolveDatabase(req.productId);
    const backend = new Neo4jBackend({
      url: this.opts.neo4jUrl,
      user: this.opts.neo4jUser ?? 'neo4j',
      password: this.opts.neo4jPassword,
      database,
      vectorDim: this.embedder.dim,
    });
    try {
      const summary = await runConfluenceIngest({
        fetcher: this.confluenceFetcher,
        backend,
        embedderConfig: this.embedder,
        request: req,
        signal,
        onEvent: (e) => this.emit(ingestId, e),
      });
      this.transitionCompleted(ingestId, summary);
    } finally {
      await backend.close();
    }
  }

  private async runCrawlIngest(
    ingestId: string,
    req: CrawlIngestRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const status = this.must(ingestId);
    status.state = 'running';

    const scope = req.scope ?? 'page';
    const crawlReq: CrawlRequest = {
      url: req.url,
      scope,
      ...(typeof req.maxDepth === 'number' ? { maxDepth: req.maxDepth } : {}),
      ...(typeof req.maxPages === 'number' ? { maxPages: req.maxPages } : {}),
      ...(req.allowedDomains ? { allowedDomains: req.allowedDomains } : {}),
      ...(typeof req.rateLimitPerHost === 'number'
        ? { rateLimitPerHost: req.rateLimitPerHost }
        : {}),
      ...(req.ifNoneMatch ? { ifNoneMatch: req.ifNoneMatch } : {}),
      ...(req.ifModifiedSince ? { ifModifiedSince: req.ifModifiedSince } : {}),
    };

    this.emit(ingestId, {
      kind: 'source-resolved',
      source: { kind: 'url', url: req.url },
      itemCount: 0,
    });

    const database = await this.resolveDatabase(req.productId);
    const backend = new Neo4jBackend({
      url: this.opts.neo4jUrl,
      user: this.opts.neo4jUser ?? 'neo4j',
      password: this.opts.neo4jPassword,
      database,
      vectorDim: this.embedder.dim,
    });
    const embedder = createHttpEmbedderClient({ config: this.embedder });
    let pageCount = 0;
    let errors = 0;

    try {
      await backend.ensureSchema({ nodes: ['Doc'], edges: [] });

      for await (const result of this.crawler.crawlMany(crawlReq, signal)) {
        if (signal.aborted) break;
        if (result.notModified) continue;
        if (!result.contentMarkdown) continue;

        const docId = `crawl:${result.finalUrl}`;
        const text = result.title
          ? `# ${result.title}\n\n${result.contentMarkdown}`
          : result.contentMarkdown;

        this.emit(ingestId, {
          kind: 'item-walked',
          itemId: result.finalUrl,
          itemType: 'page',
          sizeBytes: text.length,
        });

        const embedStart = Date.now();
        try {
          const [vec] = await embedder.embed([text]);
          if (!vec) throw new Error('embedder returned no vector');
          this.emit(ingestId, {
            kind: 'chunk-embedded',
            chunkId: docId,
            vectorDim: vec.length,
            latencyMs: Date.now() - embedStart,
          });
          await backend.upsertNodesBulk([
            {
              id: docId,
              label: 'Doc',
              properties: {
                url: result.finalUrl,
                title: result.title ?? '',
                contentMarkdown: result.contentMarkdown,
                contentHash: result.contentHash ?? '',
                fetchedAt: result.fetchedAt,
                etag: result.etag ?? '',
                lastModified: result.lastModified ?? '',
              },
              sourceTypeId: 'crawl',
              sourceId: req.productId ?? new URL(result.finalUrl).host,
            },
          ]);
          await backend.upsertVectorsBulk([
            { nodeId: docId, vector: vec, meta: { kind: 'crawl' } },
          ]);
          this.emit(ingestId, { kind: 'node-written', nodeId: docId, label: 'Doc' });
          pageCount += 1;
        } catch (err) {
          errors += 1;
          this.emit(ingestId, {
            kind: 'error',
            phase: 'embed',
            item: result.finalUrl,
            message: (err as Error).message,
          });
        }
      }

      this.transitionCompleted(ingestId, {
        filesIngested: pageCount,
        filesSkipped: 0,
        chunksWritten: pageCount,
        vectorsWritten: pageCount,
        errors,
        durationMs: 0,
      });
    } finally {
      await backend.close();
    }
  }

  private async runUploadIngest(ingestId: string, entry: UploadEntry): Promise<void> {
    const status = this.must(ingestId);
    status.state = 'running';

    const database = await this.resolveDatabase(entry.productId);
    const session = this.driver.session({ database });
    try {
      // Minimal upload-graph write: a single Doc node with localPath +
      // metadata. v1 doesn't yet chunk + embed PDF/image content; that
      // lands when the per-content-type embedding strategy is built out.
      await session.run(
        `MERGE (n:Doc {id: $id})
           ON CREATE SET
             n.filename = $filename,
             n.contentType = $contentType,
             n.sizeBytes = $sizeBytes,
             n.uploadedAt = $uploadedAt,
             n.localPath = $localPath,
             n.sourceId = $productId,
             n.sourceTypeId = 'upload',
             n.description = $description`,
        {
          id: entry.docId,
          filename: entry.filename,
          contentType: entry.contentType,
          sizeBytes: neo4j.int(entry.sizeBytes),
          uploadedAt: entry.uploadedAt,
          localPath: entry.localPath,
          productId: entry.productId ?? '',
          description: entry.description ?? '',
        },
      );
      this.emit(ingestId, {
        kind: 'node-written',
        nodeId: entry.docId,
        label: 'Doc',
      });
      this.transitionCompleted(ingestId, {
        filesIngested: 1,
        filesSkipped: 0,
        chunksWritten: 0,
        vectorsWritten: 0,
        errors: 0,
        durationMs: 0,
      });
    } finally {
      await session.close();
    }
  }

  /** Returns the database name to write to, ensuring it exists. */
  private async resolveDatabase(productId: string | undefined): Promise<string> {
    if (!productId) return this.defaultDatabase;
    if (!SAFE_DB_NAME.test(productId)) {
      throw new Error(
        `invalid productId: must match ${SAFE_DB_NAME.source} (Neo4j database naming rules)`,
      );
    }
    if (this.ensuredDbs.has(productId)) return productId;

    // Neo4j Enterprise has multi-database; Community Edition does NOT.
    // We attempt CREATE DATABASE IF NOT EXISTS and fall through gracefully
    // if the server is Community — caller targets the default DB.
    const sysSession = this.driver.session({ database: 'system' });
    try {
      await sysSession.run(`CREATE DATABASE \`${productId}\` IF NOT EXISTS WAIT`);
      this.ensuredDbs.add(productId);
      return productId;
    } catch (err) {
      const msg = (err as Error).message;
      // Community Edition rejects multi-database with 'Unsupported administration command'
      // — fall back to default and warn once.
      if (msg.includes('Unsupported administration command') || msg.includes('CommunityEdition')) {
        this.ensuredDbs.add(productId); // mark so we don't retry every ingest
        return this.defaultDatabase;
      }
      throw err;
    } finally {
      await sysSession.close();
    }
  }

  private emit(ingestId: string, event: IngestionEvent): void {
    const status = this.ingests.get(ingestId);
    if (!status) return;
    if (status.events.length >= EVENT_BUFFER_MAX) {
      status.events.shift(); // drop oldest
    }
    status.events.push(event);
    const subs = this.subscribers.get(ingestId);
    if (subs) {
      for (const cb of subs) {
        try {
          cb(event);
        } catch {
          // a subscriber's broken — don't crash the ingest
        }
      }
    }
  }

  private transitionCompleted(ingestId: string, summary: IngestionSummary): void {
    const status = this.ingests.get(ingestId);
    if (!status) return;
    if (status.state === 'cancelled') return; // already finalized
    status.state = 'completed';
    status.completedAt = new Date().toISOString();
    status.summary = summary;
    this.emit(ingestId, {
      kind: 'source-completed',
      filesIngested: summary.filesIngested,
      filesSkipped: summary.filesSkipped,
      chunksWritten: summary.chunksWritten,
      vectorsWritten: summary.vectorsWritten,
      errors: summary.errors,
    });
    this.cancellers.delete(ingestId);
  }

  private transitionFailed(ingestId: string, message: string): void {
    const status = this.ingests.get(ingestId);
    if (!status) return;
    if (status.state === 'cancelled') return;
    status.state = 'failed';
    status.completedAt = new Date().toISOString();
    status.error = message;
    this.emit(ingestId, { kind: 'error', phase: 'ingest', message });
    this.cancellers.delete(ingestId);
  }

  private must(ingestId: string): IngestStatus {
    const s = this.ingests.get(ingestId);
    if (!s) throw new Error(`ingest not found: ${ingestId}`);
    return s;
  }
}

function newIngestId(): string {
  return `ing_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function runGitClone(
  cloneUrl: string,
  branch: string | undefined,
  dest: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['clone', '--depth', '1'];
    if (branch) args.push('--branch', branch);
    args.push('--', cloneUrl, dest);
    const child = spawn('git', args, { stdio: 'pipe', signal });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git clone exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

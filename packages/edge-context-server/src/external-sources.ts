/**
 * External-source ingestion (PRD F24 / CS-7b).
 *
 * v1 ships three adapters — **GitHub Issues** (reference), **Jira**,
 * and **Confluence**. All three share the same shape:
 *
 *   1. A typed fetcher class that knows how to paginate the source's
 *      REST API and yield items as an AsyncIterable.
 *   2. A `runX` function that drives the fetcher → embedder → graph,
 *      emitting IngestionEvents for the WS event stream and bulk
 *      writing to Neo4j every 50 items.
 *
 * Credentials in v1 = environment variables. The PRD's eventual
 * CredentialBroker-mediated path is parked because `agent-auth-lib`'s
 * broker is typed to LLM providers, not arbitrary external systems.
 *
 *   GITHUB_TOKEN, GITHUB_API_BASE
 *   JIRA_TOKEN, JIRA_BASE_URL, JIRA_EMAIL
 *   CONFLUENCE_TOKEN, CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL
 *
 * Writes go straight to the graph (Issue / JiraIssue / ConfluencePage
 * nodes + embedding) via Neo4jBackend bulk APIs — bypassing loader-core's
 * ingest() because that pipeline is path-rooted today and can't yet
 * consume external-source SourceRef kinds.
 */

import {
  type EmbedderClient,
  type GraphIngestionBackend,
  createHttpEmbedderClient,
  type EmbedderConfig,
} from '@ecruz165/context-loader-core';

export interface GithubIssuesIngestRequest {
  /** Caller-meaningful name. */
  name: string;
  /** "owner/repo" — required. */
  repo: string;
  /** Filter by labels (comma-separated). Optional. */
  labels?: string[];
  /** open | closed | all. Default 'all'. */
  state?: 'open' | 'closed' | 'all';
  /** ISO timestamp; only fetch issues updated after this. Optional. */
  since?: string;
  /** Max pages to fetch (each page = 100 issues). Default 10. */
  maxPages?: number;
  productId?: string;
}

export interface GithubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string }>;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request?: unknown;
}

export interface ExternalSourceFetcher {
  fetchIssues(req: GithubIssuesIngestRequest): AsyncIterable<GithubIssue>;
}

export interface ExternalSourceOptions {
  fetchImpl?: typeof fetch;
  envGet?: (key: string) => string | undefined;
}

export class GithubIssuesFetcher implements ExternalSourceFetcher {
  private readonly fetchImpl: typeof fetch;
  private readonly envGet: (key: string) => string | undefined;

  constructor(opts: ExternalSourceOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.envGet = opts.envGet ?? ((k) => process.env[k]);
  }

  async *fetchIssues(req: GithubIssuesIngestRequest): AsyncIterable<GithubIssue> {
    const token = this.envGet('GITHUB_TOKEN');
    if (!token) {
      throw new Error('GITHUB_TOKEN env var required for GitHub Issues ingestion');
    }
    const apiBase = this.envGet('GITHUB_API_BASE') ?? 'https://api.github.com';
    if (!/^[\w.-]+\/[\w.-]+$/.test(req.repo)) {
      throw new Error(`invalid repo format: '${req.repo}' (expected 'owner/name')`);
    }

    const maxPages = req.maxPages ?? 10;
    const labelsParam = req.labels && req.labels.length > 0
      ? `&labels=${encodeURIComponent(req.labels.join(','))}`
      : '';
    const stateParam = `&state=${req.state ?? 'all'}`;
    const sinceParam = req.since ? `&since=${encodeURIComponent(req.since)}` : '';

    for (let page = 1; page <= maxPages; page++) {
      const url = `${apiBase}/repos/${req.repo}/issues?per_page=100&page=${page}${stateParam}${labelsParam}${sinceParam}`;
      const r = await this.fetchImpl(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
      });
      if (r.status === 401) throw new Error('GitHub returned 401 — check GITHUB_TOKEN');
      if (r.status === 403) {
        const msg = r.headers.get('x-ratelimit-remaining') === '0'
          ? 'GitHub rate limit exhausted'
          : 'GitHub returned 403 — token lacks scope?';
        throw new Error(msg);
      }
      if (r.status >= 400) throw new Error(`GitHub returned ${r.status} for ${url}`);

      const issues = (await r.json()) as GithubIssue[];
      // Filter out PRs — GitHub returns PRs in /issues by default.
      for (const issue of issues) {
        if (!issue.pull_request) yield issue;
      }
      if (issues.length < 100) return; // last page
    }
  }
}

/**
 * Drives a fetcher through to the graph. Emits IngestionEvent-shaped
 * events compatible with the existing IngestService event stream so
 * downstream consumers (CLI, WS subscribers) don't need to special-case
 * this intake path.
 */
export interface ExternalIngestRunOptions {
  fetcher: ExternalSourceFetcher;
  backend: GraphIngestionBackend;
  embedderConfig: EmbedderConfig;
  embedder?: EmbedderClient;
  request: GithubIssuesIngestRequest;
  onEvent?: (event: ExternalIngestEvent) => void;
  signal?: AbortSignal;
}

/**
 * Wire-compatible with loader-core's `IngestionEvent` so emitted events
 * round-trip through the IngestService event stream alongside repo /
 * upload / crawl events. Each adapter emits a `source-resolved` event
 * with a SourceRef matching loader-core's union (github-issues, jira,
 * url) — Confluence uses `url` since loader-core has no confluence
 * variant in v1.
 */
type EmittedSourceRef =
  | { kind: 'github-issues'; owner: string; repo: string }
  | { kind: 'jira'; project: string; baseUrl: string }
  | { kind: 'url'; url: string };

export type ExternalIngestEvent =
  | { kind: 'source-resolved'; source: EmittedSourceRef; itemCount: number }
  | { kind: 'item-walked'; itemId: string; itemType: string; sizeBytes: number }
  | { kind: 'node-written'; nodeId: string; label: string }
  | { kind: 'chunk-embedded'; chunkId: string; vectorDim: number; latencyMs: number }
  | {
      kind: 'source-completed';
      filesIngested: number;
      filesSkipped: number;
      chunksWritten: number;
      vectorsWritten: number;
      errors: number;
    }
  | { kind: 'error'; phase: string; item?: string; message: string };

export interface ExternalIngestSummary {
  filesIngested: number;
  filesSkipped: number;
  chunksWritten: number;
  vectorsWritten: number;
  errors: number;
  durationMs: number;
}

// ─── Jira ────────────────────────────────────────────────────────────

export interface JiraIngestRequest {
  /** Caller-meaningful name. */
  name: string;
  /** JQL filter — required. e.g., "project = MOBILE AND updated > -7d" */
  jql: string;
  /** Max issues to fetch. Default 100, hard cap 1000. */
  maxResults?: number;
  /** Fields to include — defaults to summary,description,status,issuetype,priority,labels,assignee,reporter,created,updated. */
  fields?: string[];
  productId?: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description?: string | null;
    status?: { name: string };
    issuetype?: { name: string };
    priority?: { name: string };
    labels?: string[];
    assignee?: { displayName: string; emailAddress?: string } | null;
    reporter?: { displayName: string } | null;
    created: string;
    updated: string;
  };
}

export class JiraFetcher {
  private readonly fetchImpl: typeof fetch;
  private readonly envGet: (key: string) => string | undefined;

  constructor(opts: ExternalSourceOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.envGet = opts.envGet ?? ((k) => process.env[k]);
  }

  async *fetchIssues(req: JiraIngestRequest): AsyncIterable<JiraIssue> {
    const token = this.envGet('JIRA_TOKEN');
    const baseUrl = this.envGet('JIRA_BASE_URL');
    const email = this.envGet('JIRA_EMAIL');
    if (!token) throw new Error('JIRA_TOKEN env var required for Jira ingestion');
    if (!baseUrl) throw new Error('JIRA_BASE_URL env var required (e.g., https://myorg.atlassian.net)');
    if (!email) throw new Error('JIRA_EMAIL env var required (Atlassian Cloud uses email+token Basic auth)');

    // Atlassian Cloud uses Basic auth with email:token. Self-hosted
    // Jira uses Bearer; we default to Basic which works for Cloud and
    // the operator can flip to Bearer by setting JIRA_AUTH_SCHEME=Bearer.
    const scheme = this.envGet('JIRA_AUTH_SCHEME') ?? 'Basic';
    const authHeader =
      scheme === 'Basic'
        ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
        : `Bearer ${token}`;

    const fields = req.fields ?? [
      'summary',
      'description',
      'status',
      'issuetype',
      'priority',
      'labels',
      'assignee',
      'reporter',
      'created',
      'updated',
    ];
    const cap = Math.min(req.maxResults ?? 100, 1000);
    const pageSize = 100;
    let startAt = 0;
    let total = 0;

    while (startAt < cap) {
      const params = new URLSearchParams({
        jql: req.jql,
        startAt: String(startAt),
        maxResults: String(Math.min(pageSize, cap - startAt)),
        fields: fields.join(','),
      });
      const url = `${baseUrl.replace(/\/$/, '')}/rest/api/3/search?${params.toString()}`;
      const r = await this.fetchImpl(url, {
        headers: { authorization: authHeader, accept: 'application/json' },
      });
      if (r.status === 401) throw new Error('Jira returned 401 — check JIRA_TOKEN / JIRA_EMAIL');
      if (r.status === 403) throw new Error('Jira returned 403 — token lacks scope?');
      if (r.status >= 400) throw new Error(`Jira returned ${r.status} for ${url}`);

      const data = (await r.json()) as { issues: JiraIssue[]; total: number; startAt: number };
      total += data.issues.length;
      for (const issue of data.issues) yield issue;
      if (data.issues.length < pageSize) return;
      startAt += pageSize;
      if (total >= data.total) return;
    }
  }
}

// ─── Confluence ─────────────────────────────────────────────────────

export interface ConfluenceIngestRequest {
  /** Caller-meaningful name. */
  name: string;
  /** Space key (e.g., 'ENG'). */
  space: string;
  /** Max pages to fetch. Default 100, hard cap 1000. */
  maxResults?: number;
  productId?: string;
}

export interface ConfluencePage {
  id: string;
  title: string;
  body?: { storage?: { value?: string }; atlas_doc_format?: { value?: string } };
  status: string;
  spaceId?: string;
  parentId?: string | null;
  createdAt: string;
  version?: { number: number; createdAt: string };
  _links?: { webui?: string };
}

export class ConfluenceFetcher {
  private readonly fetchImpl: typeof fetch;
  private readonly envGet: (key: string) => string | undefined;

  constructor(opts: ExternalSourceOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.envGet = opts.envGet ?? ((k) => process.env[k]);
  }

  async *fetchPages(req: ConfluenceIngestRequest): AsyncIterable<ConfluencePage> {
    const token = this.envGet('CONFLUENCE_TOKEN');
    const baseUrl = this.envGet('CONFLUENCE_BASE_URL');
    const email = this.envGet('CONFLUENCE_EMAIL');
    if (!token) throw new Error('CONFLUENCE_TOKEN env var required');
    if (!baseUrl)
      throw new Error('CONFLUENCE_BASE_URL env var required (e.g., https://myorg.atlassian.net)');
    if (!email) throw new Error('CONFLUENCE_EMAIL env var required for Atlassian Cloud Basic auth');

    const scheme = this.envGet('CONFLUENCE_AUTH_SCHEME') ?? 'Basic';
    const authHeader =
      scheme === 'Basic'
        ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
        : `Bearer ${token}`;

    // Confluence v2 API: paginated via cursor in the `Link` header.
    // We do simple offset-style pagination by following _links.next
    // when present in the response payload.
    const cap = Math.min(req.maxResults ?? 100, 1000);
    const pageSize = 100;
    let count = 0;
    let nextUrl =
      `${baseUrl.replace(/\/$/, '')}/wiki/api/v2/spaces/${encodeURIComponent(req.space)}/pages?body-format=storage&limit=${pageSize}`;

    while (nextUrl && count < cap) {
      const r = await this.fetchImpl(nextUrl, {
        headers: { authorization: authHeader, accept: 'application/json' },
      });
      if (r.status === 401) throw new Error('Confluence returned 401 — check CONFLUENCE_TOKEN');
      if (r.status === 403) throw new Error('Confluence returned 403 — token lacks scope?');
      if (r.status === 404) throw new Error(`Confluence space '${req.space}' not found`);
      if (r.status >= 400) throw new Error(`Confluence returned ${r.status} for ${nextUrl}`);

      const data = (await r.json()) as {
        results: ConfluencePage[];
        _links?: { next?: string };
      };
      for (const page of data.results) {
        if (count >= cap) return;
        yield page;
        count += 1;
      }
      // _links.next is relative to base; resolve if present.
      if (data._links?.next) {
        const next = data._links.next;
        nextUrl = next.startsWith('http') ? next : `${baseUrl.replace(/\/$/, '')}/wiki${next}`;
      } else {
        nextUrl = '';
      }
    }
  }
}

// ─── runners ────────────────────────────────────────────────────────

export async function runGithubIssuesIngest(
  opts: ExternalIngestRunOptions,
): Promise<ExternalIngestSummary> {
  const { fetcher, backend, embedderConfig, request, onEvent, signal } = opts;
  const startedAt = Date.now();
  const embedder = opts.embedder ?? createHttpEmbedderClient({ config: embedderConfig });

  // Make sure the schema is in place before any writes.
  await backend.ensureSchema({ nodes: ['Issue'], edges: [] });

  let count = 0;
  let errors = 0;

  // Buffer issues + their embeddings into one batch per page (~100 items)
  // for efficient bulk write. Saves on per-issue Bolt round-trips.
  const batchSize = 50;
  let batch: Array<{ issue: GithubIssue; vec: Float32Array }> = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const nodes = batch.map((b) => ({
      id: `gh-issue:${request.repo}#${b.issue.number}`,
      label: 'Issue',
      properties: {
        title: b.issue.title,
        body: b.issue.body ?? '',
        state: b.issue.state,
        labels: b.issue.labels.map((l) => l.name).join(','),
        author: b.issue.user?.login ?? '',
        url: b.issue.html_url,
        createdAt: b.issue.created_at,
        updatedAt: b.issue.updated_at,
        repo: request.repo,
        issueNumber: b.issue.number,
      },
      sourceTypeId: 'github-issues',
      sourceId: request.productId ?? request.repo,
    }));
    await backend.upsertNodesBulk(nodes);
    await backend.upsertVectorsBulk(
      batch.map((b) => ({
        nodeId: `gh-issue:${request.repo}#${b.issue.number}`,
        vector: b.vec,
        meta: { kind: 'github-issue' },
      })),
    );
    for (const n of nodes) {
      onEvent?.({ kind: 'node-written', nodeId: n.id, label: n.label });
    }
    batch = [];
  };

  const [owner, repoName] = request.repo.split('/', 2);
  onEvent?.({
    kind: 'source-resolved',
    source: { kind: 'github-issues', owner: owner ?? '', repo: repoName ?? '' },
    itemCount: 0,
  });

  try {
    for await (const issue of fetcher.fetchIssues(request)) {
      if (signal?.aborted) break;
      const text = `# ${issue.title}\n\n${issue.body ?? ''}`;
      onEvent?.({
        kind: 'item-walked',
        itemId: `${request.repo}#${issue.number}`,
        itemType: 'issue',
        sizeBytes: text.length,
      });
      const embedStart = Date.now();
      try {
        const [vec] = await embedder.embed([text]);
        if (!vec) throw new Error('embedder returned no vector');
        onEvent?.({
          kind: 'chunk-embedded',
          chunkId: `gh-issue:${request.repo}#${issue.number}`,
          vectorDim: vec.length,
          latencyMs: Date.now() - embedStart,
        });
        batch.push({ issue, vec });
        count += 1;
        if (batch.length >= batchSize) await flush();
      } catch (err) {
        errors += 1;
        onEvent?.({
          kind: 'error',
          phase: 'embed',
          item: `${request.repo}#${issue.number}`,
          message: (err as Error).message,
        });
      }
    }
    await flush();
  } catch (err) {
    errors += 1;
    onEvent?.({ kind: 'error', phase: 'fetch', message: (err as Error).message });
    throw err;
  }

  const summary: ExternalIngestSummary = {
    filesIngested: count,
    filesSkipped: 0,
    chunksWritten: count,
    vectorsWritten: count,
    errors,
    durationMs: Date.now() - startedAt,
  };
  onEvent?.({
    kind: 'source-completed',
    filesIngested: summary.filesIngested,
    filesSkipped: summary.filesSkipped,
    chunksWritten: summary.chunksWritten,
    vectorsWritten: summary.vectorsWritten,
    errors: summary.errors,
  });
  return summary;
}

export interface JiraRunOptions extends Omit<ExternalIngestRunOptions, 'fetcher' | 'request'> {
  fetcher: JiraFetcher;
  request: JiraIngestRequest;
}

export async function runJiraIngest(opts: JiraRunOptions): Promise<ExternalIngestSummary> {
  const { fetcher, backend, embedderConfig, request, onEvent, signal } = opts;
  const startedAt = Date.now();
  const embedder = opts.embedder ?? createHttpEmbedderClient({ config: embedderConfig });

  await backend.ensureSchema({ nodes: ['JiraIssue'], edges: [] });

  let count = 0;
  let errors = 0;
  const batchSize = 50;
  let batch: Array<{ issue: JiraIssue; vec: Float32Array }> = [];

  // Jira's SourceRef variant in loader-core: { kind: 'jira', project, baseUrl }
  const project = (request.jql.match(/project\s*=\s*"?([\w-]+)"?/i) ?? [])[1] ?? '';
  const baseUrl =
    (typeof process !== 'undefined' ? process.env.JIRA_BASE_URL : undefined) ?? '';
  onEvent?.({
    kind: 'source-resolved',
    source: { kind: 'jira', project, baseUrl },
    itemCount: 0,
  });

  const flush = async () => {
    if (batch.length === 0) return;
    const nodes = batch.map((b) => ({
      id: `jira:${b.issue.key}`,
      label: 'JiraIssue',
      properties: {
        key: b.issue.key,
        summary: b.issue.fields.summary,
        description: jiraDescriptionToText(b.issue.fields.description),
        status: b.issue.fields.status?.name ?? '',
        issueType: b.issue.fields.issuetype?.name ?? '',
        priority: b.issue.fields.priority?.name ?? '',
        labels: (b.issue.fields.labels ?? []).join(','),
        assignee: b.issue.fields.assignee?.displayName ?? '',
        reporter: b.issue.fields.reporter?.displayName ?? '',
        createdAt: b.issue.fields.created,
        updatedAt: b.issue.fields.updated,
      },
      sourceTypeId: 'jira',
      sourceId: request.productId ?? project,
    }));
    await backend.upsertNodesBulk(nodes);
    await backend.upsertVectorsBulk(
      batch.map((b) => ({
        nodeId: `jira:${b.issue.key}`,
        vector: b.vec,
        meta: { kind: 'jira-issue' },
      })),
    );
    for (const n of nodes) onEvent?.({ kind: 'node-written', nodeId: n.id, label: n.label });
    batch = [];
  };

  try {
    for await (const issue of fetcher.fetchIssues(request)) {
      if (signal?.aborted) break;
      const description = jiraDescriptionToText(issue.fields.description);
      const text = `# ${issue.fields.summary}\n\n${description}`;
      onEvent?.({
        kind: 'item-walked',
        itemId: issue.key,
        itemType: 'jira-issue',
        sizeBytes: text.length,
      });
      const embedStart = Date.now();
      try {
        const [vec] = await embedder.embed([text]);
        if (!vec) throw new Error('embedder returned no vector');
        onEvent?.({
          kind: 'chunk-embedded',
          chunkId: `jira:${issue.key}`,
          vectorDim: vec.length,
          latencyMs: Date.now() - embedStart,
        });
        batch.push({ issue, vec });
        count += 1;
        if (batch.length >= batchSize) await flush();
      } catch (err) {
        errors += 1;
        onEvent?.({ kind: 'error', phase: 'embed', item: issue.key, message: (err as Error).message });
      }
    }
    await flush();
  } catch (err) {
    errors += 1;
    onEvent?.({ kind: 'error', phase: 'fetch', message: (err as Error).message });
    throw err;
  }

  const summary: ExternalIngestSummary = {
    filesIngested: count,
    filesSkipped: 0,
    chunksWritten: count,
    vectorsWritten: count,
    errors,
    durationMs: Date.now() - startedAt,
  };
  onEvent?.({
    kind: 'source-completed',
    filesIngested: summary.filesIngested,
    filesSkipped: summary.filesSkipped,
    chunksWritten: summary.chunksWritten,
    vectorsWritten: summary.vectorsWritten,
    errors: summary.errors,
  });
  return summary;
}

/** Atlassian Document Format → plain text. v1 walks the doc tree
 *  taking text-bearing nodes; ignores formatting marks. Good enough
 *  for embedding; full ADF→Markdown is a separate slice. */
function jiraDescriptionToText(desc: unknown): string {
  if (!desc) return '';
  if (typeof desc === 'string') return desc;
  const out: string[] = [];
  walk(desc);
  return out.join('').trim();
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (typeof n.text === 'string') out.push(n.text);
    if (Array.isArray(n.content)) {
      for (const c of n.content) walk(c);
      if (n.type === 'paragraph' || n.type === 'heading') out.push('\n\n');
    }
  }
}

export interface ConfluenceRunOptions extends Omit<ExternalIngestRunOptions, 'fetcher' | 'request'> {
  fetcher: ConfluenceFetcher;
  request: ConfluenceIngestRequest;
}

export async function runConfluenceIngest(
  opts: ConfluenceRunOptions,
): Promise<ExternalIngestSummary> {
  const { fetcher, backend, embedderConfig, request, onEvent, signal } = opts;
  const startedAt = Date.now();
  const embedder = opts.embedder ?? createHttpEmbedderClient({ config: embedderConfig });

  await backend.ensureSchema({ nodes: ['ConfluencePage'], edges: [] });

  let count = 0;
  let errors = 0;
  const batchSize = 25; // pages tend to be larger than issues
  let batch: Array<{ page: ConfluencePage; vec: Float32Array }> = [];

  const baseUrl =
    (typeof process !== 'undefined' ? process.env.CONFLUENCE_BASE_URL : undefined) ?? '';
  // Confluence has no SourceRef variant in loader-core today; emit
  // a `url` SourceRef pointing at the space root — accurate and
  // forward-compatible with a future 'confluence' kind.
  onEvent?.({
    kind: 'source-resolved',
    source: {
      kind: 'url',
      url: `${baseUrl.replace(/\/$/, '')}/wiki/spaces/${request.space}`,
    },
    itemCount: 0,
  });

  const flush = async () => {
    if (batch.length === 0) return;
    const nodes = batch.map((b) => ({
      id: `confluence:${b.page.id}`,
      label: 'ConfluencePage',
      properties: {
        title: b.page.title,
        body: confluencePageBody(b.page),
        status: b.page.status,
        space: request.space,
        parentId: b.page.parentId ?? '',
        createdAt: b.page.createdAt,
        updatedAt: b.page.version?.createdAt ?? b.page.createdAt,
        version: b.page.version?.number ?? 1,
        url: b.page._links?.webui ? `${baseUrl.replace(/\/$/, '')}/wiki${b.page._links.webui}` : '',
      },
      sourceTypeId: 'confluence',
      sourceId: request.productId ?? request.space,
    }));
    await backend.upsertNodesBulk(nodes);
    await backend.upsertVectorsBulk(
      batch.map((b) => ({
        nodeId: `confluence:${b.page.id}`,
        vector: b.vec,
        meta: { kind: 'confluence-page' },
      })),
    );
    for (const n of nodes) onEvent?.({ kind: 'node-written', nodeId: n.id, label: n.label });
    batch = [];
  };

  try {
    for await (const page of fetcher.fetchPages(request)) {
      if (signal?.aborted) break;
      const body = confluencePageBody(page);
      const text = `# ${page.title}\n\n${body}`;
      onEvent?.({
        kind: 'item-walked',
        itemId: page.id,
        itemType: 'confluence-page',
        sizeBytes: text.length,
      });
      const embedStart = Date.now();
      try {
        const [vec] = await embedder.embed([text]);
        if (!vec) throw new Error('embedder returned no vector');
        onEvent?.({
          kind: 'chunk-embedded',
          chunkId: `confluence:${page.id}`,
          vectorDim: vec.length,
          latencyMs: Date.now() - embedStart,
        });
        batch.push({ page, vec });
        count += 1;
        if (batch.length >= batchSize) await flush();
      } catch (err) {
        errors += 1;
        onEvent?.({ kind: 'error', phase: 'embed', item: page.id, message: (err as Error).message });
      }
    }
    await flush();
  } catch (err) {
    errors += 1;
    onEvent?.({ kind: 'error', phase: 'fetch', message: (err as Error).message });
    throw err;
  }

  const summary: ExternalIngestSummary = {
    filesIngested: count,
    filesSkipped: 0,
    chunksWritten: count,
    vectorsWritten: count,
    errors,
    durationMs: Date.now() - startedAt,
  };
  onEvent?.({
    kind: 'source-completed',
    filesIngested: summary.filesIngested,
    filesSkipped: summary.filesSkipped,
    chunksWritten: summary.chunksWritten,
    vectorsWritten: summary.vectorsWritten,
    errors: summary.errors,
  });
  return summary;
}

/** Confluence v2 returns body in storage format (basically HTML).
 *  Strip tags + decode entities for embedding-friendly plain text. */
function confluencePageBody(page: ConfluencePage): string {
  const raw = page.body?.storage?.value ?? page.body?.atlas_doc_format?.value ?? '';
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

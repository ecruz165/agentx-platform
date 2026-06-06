/**
 * In-process integration tests — spin up edge-context-server with a
 * StubQueryService, then call `run()` against the resulting socket.
 * Asserts both happy paths (status code 0, expected stdout) and error
 * shaping (ENOENT / ECONNREFUSED / non-2xx).
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ContextQueryRequest,
  type ContextQueryResult,
  type ContextStatsResult,
  type ConfluenceIngestRequest,
  type CrawlIngestRequest,
  type JiraIngestRequest,
  type CypherRequest,
  type CypherResult,
  type EventCallback,
  type GithubIssuesIngestRequest,
  type IngestService,
  type IngestStatus,
  type QueryService,
  type RelatedRequest,
  type RelatedResult,
  type RepoIngestRequest,
  startContextServer,
  type TraverseRequest,
  type TraverseResult,
  type UploadEntry,
  type UploadIngestRequest,
} from '@ecruz165/edge-context-server';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from './main.ts';

const tmpSocket = () => join(tmpdir(), `ctxcli-${randomUUID().slice(0, 8)}.sock`);

class StubQueryService implements QueryService {
  lastTraverse?: TraverseRequest;
  lastRelated?: RelatedRequest;
  lastCypher?: CypherRequest;

  async query(req: ContextQueryRequest): Promise<ContextQueryResult> {
    return {
      q: req.q,
      productId: req.productId,
      hits: [
        {
          nodeId: 's1',
          label: 'Symbol',
          score: 0.92,
          properties: { text: 'a search hit' },
          via: 'vector',
        },
      ],
      searchedLabels: ['Symbol'],
      topK: req.topK ?? 10,
      embeddingMs: 1,
      searchMs: 1,
    };
  }

  async stats(): Promise<ContextStatsResult> {
    return { nodeCount: 100, edgeCount: 200, indexedLabels: ['Symbol'], ts: '2026-05-07T00:00:00Z' };
  }

  async traverse(req: TraverseRequest): Promise<TraverseResult> {
    this.lastTraverse = req;
    return {
      entity: req.entity,
      depth: req.depth,
      nodes: [
        { nodeId: req.entity, label: 'Function', properties: { name: req.entity }, distance: 0 },
        { nodeId: 'callee-1', label: 'Function', properties: { name: 'callee-1' }, distance: 1 },
      ],
      edges: [{ fromNodeId: req.entity, toNodeId: 'callee-1', type: 'CALLS', properties: {} }],
      truncated: false,
    };
  }

  async related(req: RelatedRequest): Promise<RelatedResult> {
    this.lastRelated = req;
    return {
      entity: req.entity,
      predicate: req.predicate,
      depth: req.depth,
      hits: [{ nodeId: 'r1', label: 'Doc', properties: { title: 'related-doc' }, distance: 1 }],
      truncated: false,
    };
  }

  async cypher(req: CypherRequest): Promise<CypherResult> {
    this.lastCypher = req;
    return {
      columns: ['n'],
      rows: [{ n: { _kind: 'node', labels: ['Function'], properties: { name: 'auth' } } }],
      rowCount: 1,
      truncated: false,
    };
  }

  async close(): Promise<void> {}
}

interface RunHarness {
  out: string[];
  err: string[];
  socketPath: string;
  stub: StubQueryService;
}

async function spinUp(): Promise<RunHarness & { stop: () => Promise<void> }> {
  const socketPath = tmpSocket();
  const stub = new StubQueryService();
  const handle = await startContextServer({ socketPath, query: stub });
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    socketPath,
    stub,
    async stop() {
      await handle.stop();
      await rm(socketPath, { force: true });
    },
  };
}

function makeIO(h: RunHarness, args: string[]) {
  return {
    argv: ['--socket', h.socketPath, ...args],
    env: {},
    stdout: (s: string) => h.out.push(s),
    stderr: (s: string) => h.err.push(s),
  };
}

describe('harness-context CLI', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('traverse → human output includes nodes + edges', async () => {
    const h = await spinUp();
    cleanups.push(h.stop);

    const code = await run(makeIO(h, ['traverse', '--entity', 'AuthService', '--depth', '2']));
    expect(code).toBe(0);
    const out = h.out.join('');
    expect(out).toContain('entity: AuthService');
    expect(out).toContain('NODES:');
    expect(out).toContain('callee-1');
    expect(out).toContain('CALLS');
    expect(h.stub.lastTraverse?.entity).toBe('AuthService');
    expect(h.stub.lastTraverse?.depth).toBe(2);
  });

  it('traverse --json → emits parseable JSON', async () => {
    const h = await spinUp();
    cleanups.push(h.stop);

    const code = await run(
      makeIO(h, ['traverse', '--entity', 'AuthService', '--depth', '1', '--json']),
    );
    expect(code).toBe(0);
    const out = h.out.join('').trim();
    const parsed = JSON.parse(out);
    expect(parsed.entity).toBe('AuthService');
    expect(parsed.nodes).toHaveLength(2);
  });

  it('traverse forwards --predicate as a comma-split list', async () => {
    const h = await spinUp();
    cleanups.push(h.stop);

    await run(
      makeIO(h, [
        'traverse',
        '--entity',
        'X',
        '--depth',
        '1',
        '--predicate',
        'CALLS,IMPORTS',
      ]),
    );
    expect(h.stub.lastTraverse?.predicates).toEqual(['CALLS', 'IMPORTS']);
  });

  it('related → human output lists hits', async () => {
    const h = await spinUp();
    cleanups.push(h.stop);

    const code = await run(
      makeIO(h, ['related', '--entity', 'UserComponent', '--predicate', 'MENTIONS', '--depth', '1']),
    );
    expect(code).toBe(0);
    expect(h.out.join('')).toContain('MENTIONS');
    expect(h.out.join('')).toContain('related-doc');
  });

  it('search → human output includes scored hits', async () => {
    const h = await spinUp();
    cleanups.push(h.stop);

    const code = await run(makeIO(h, ['search', '--query', 'rate limiting', '--top-k', '5']));
    expect(code).toBe(0);
    const out = h.out.join('');
    expect(out).toContain('rate limiting');
    expect(out).toContain('0.920'); // score formatted
  });

  it('cypher → forwards positional cypher + --params', async () => {
    const h = await spinUp();
    cleanups.push(h.stop);

    const code = await run(
      makeIO(h, [
        'cypher',
        'MATCH (n:Function) WHERE n.name = $name RETURN n',
        '--params',
        '{"name":"auth"}',
      ]),
    );
    expect(code).toBe(0);
    expect(h.stub.lastCypher?.params).toEqual({ name: 'auth' });
  });

  it('cypher with malformed --params returns 1', async () => {
    const h = await spinUp();
    cleanups.push(h.stop);

    const code = await run(makeIO(h, ['cypher', 'MATCH (n) RETURN n', '--params', 'not-json']));
    expect(code).toBe(1);
    expect(h.err.join('')).toMatch(/--params/);
  });

  it('stats → human output shows counts', async () => {
    const h = await spinUp();
    cleanups.push(h.stop);

    const code = await run(makeIO(h, ['stats']));
    expect(code).toBe(0);
    expect(h.out.join('')).toContain('nodes: 100');
    expect(h.out.join('')).toContain('edges: 200');
  });

  it('health → human output shows state', async () => {
    const h = await spinUp();
    cleanups.push(h.stop);

    const code = await run(makeIO(h, ['health']));
    expect(code).toBe(0);
    expect(h.out.join('')).toContain('state: warm');
    expect(h.out.join('')).toContain('backend: neo4j');
  });

  it('unknown command exits 2 with usage', async () => {
    const h = await spinUp();
    cleanups.push(h.stop);

    const code = await run(makeIO(h, ['banana']));
    expect(code).toBe(2);
    expect(h.err.join('')).toMatch(/unknown command/);
  });

  it('no command exits 2 with usage', async () => {
    const code = await run({
      argv: [],
      env: {},
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(2);
  });

  it('--help exits 0 with usage', async () => {
    const out: string[] = [];
    const code = await run({
      argv: ['--help'],
      env: {},
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    // --help with no command still falls into "no command" branch (exit 2)
    // unless a command precedes it. Test help-after-command instead:
    const out2: string[] = [];
    const code2 = await run({
      argv: ['traverse', '--help'],
      env: {},
      stdout: (s) => out2.push(s),
      stderr: () => {},
    });
    expect(code2).toBe(0);
    expect(out2.join('')).toMatch(/Usage/);
    // Also confirm bare --help exits non-zero (no command yet) but prints usage
    expect(out.join('')).toMatch(/Usage/);
    expect(code).toBe(2);
  });

  it('socket-not-found returns 1 with helpful hint', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run({
      argv: ['--socket', '/tmp/does-not-exist.sock', 'stats'],
      env: {},
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(1);
    expect(err.join('')).toMatch(/socket not found|connection refused/);
  });
});

class StubIngestService implements IngestService {
  ingests = new Map<string, IngestStatus>();
  uploads = new Map<string, UploadEntry>();
  lastRepoReq?: RepoIngestRequest;
  lastUploadReq?: UploadIngestRequest;
  lastCrawlReq?: CrawlIngestRequest;
  lastGithubReq?: GithubIssuesIngestRequest;
  lastJiraReq?: JiraIngestRequest;
  lastConfluenceReq?: ConfluenceIngestRequest;

  async startJiraIngest(req: JiraIngestRequest): Promise<{ ingestId: string }> {
    this.lastJiraReq = req;
    const ingestId = `ing_jira_${Math.random().toString(36).slice(2, 6)}`;
    this.ingests.set(ingestId, {
      ingestId,
      kind: 'jira',
      state: 'completed',
      startedAt: '2026-05-08T00:00:00Z',
      completedAt: '2026-05-08T00:00:01Z',
      productId: req.productId,
      events: [],
    });
    return { ingestId };
  }

  async startConfluenceIngest(req: ConfluenceIngestRequest): Promise<{ ingestId: string }> {
    this.lastConfluenceReq = req;
    const ingestId = `ing_conf_${Math.random().toString(36).slice(2, 6)}`;
    this.ingests.set(ingestId, {
      ingestId,
      kind: 'confluence',
      state: 'completed',
      startedAt: '2026-05-08T00:00:00Z',
      completedAt: '2026-05-08T00:00:01Z',
      productId: req.productId,
      events: [],
    });
    return { ingestId };
  }

  async startGithubIssuesIngest(
    req: GithubIssuesIngestRequest,
  ): Promise<{ ingestId: string }> {
    this.lastGithubReq = req;
    const ingestId = `ing_gh_${Math.random().toString(36).slice(2, 8)}`;
    this.ingests.set(ingestId, {
      ingestId,
      kind: 'github-issues',
      state: 'completed',
      startedAt: '2026-05-08T00:00:00Z',
      completedAt: '2026-05-08T00:00:01Z',
      productId: req.productId,
      events: [],
    });
    return { ingestId };
  }

  async startCrawlIngest(req: CrawlIngestRequest): Promise<{ ingestId: string }> {
    this.lastCrawlReq = req;
    const ingestId = `ing_cr_${Math.random().toString(36).slice(2, 8)}`;
    this.ingests.set(ingestId, {
      ingestId,
      kind: 'crawl',
      state: 'completed',
      startedAt: '2026-05-08T00:00:00Z',
      completedAt: '2026-05-08T00:00:01Z',
      productId: req.productId,
      events: [],
    });
    return { ingestId };
  }

  async startRepoIngest(req: RepoIngestRequest): Promise<{ ingestId: string }> {
    this.lastRepoReq = req;
    const ingestId = `ing_${Math.random().toString(36).slice(2, 10)}`;
    this.ingests.set(ingestId, {
      ingestId,
      kind: 'repo',
      state: 'completed',
      startedAt: '2026-05-07T00:00:00Z',
      completedAt: '2026-05-07T00:00:01Z',
      productId: req.productId,
      summary: { filesIngested: 3, filesSkipped: 0, chunksWritten: 7, vectorsWritten: 7, errors: 0, durationMs: 50 },
      events: [],
    });
    return { ingestId };
  }
  async startUploadIngest(
    req: UploadIngestRequest,
  ): Promise<{ ingestId: string; entry: UploadEntry }> {
    this.lastUploadReq = req;
    const ingestId = `ing_up_${Math.random().toString(36).slice(2, 8)}`;
    const docId = `doc_${ingestId.slice(7)}`;
    const entry: UploadEntry = {
      docId,
      filename: req.filename,
      contentType: req.contentType ?? 'application/octet-stream',
      sizeBytes: req.bytes.byteLength,
      uploadedAt: '2026-05-07T00:00:00Z',
      localPath: `/tmp/uploads/${docId}/${req.filename}`,
      productId: req.productId,
      description: req.description,
    };
    this.uploads.set(docId, entry);
    return { ingestId, entry };
  }
  getIngest(id: string) {
    return this.ingests.get(id);
  }
  listIngests() {
    return [...this.ingests.values()];
  }
  cancelIngest(id: string): boolean {
    const s = this.ingests.get(id);
    if (!s) return false;
    s.state = 'cancelled';
    return true;
  }
  subscribe(_id: string, _cb: EventCallback): () => void {
    return () => {};
  }
  async listUploads() {
    return [...this.uploads.values()];
  }
  async deleteUpload(docId: string) {
    return this.uploads.delete(docId);
  }
  async close() {}
}

describe('harness-context CLI — ingest subcommands', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function spinUp() {
    const ingest = new StubIngestService();
    const socketPath = join(tmpdir(), `ctxcli-${randomUUID().slice(0, 8)}.sock`);
    const handle = await startContextServer({ socketPath, ingest, idleThrottleMs: 0 });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });
    return { socketPath, ingest };
  }

  it('import-repo --path forwards local source', async () => {
    const { socketPath, ingest } = await spinUp();
    const out: string[] = [];
    const code = await run({
      argv: ['--socket', socketPath, 'import-repo', '--name', 'my-app', '--path', '/tmp/foo'],
      env: {},
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(ingest.lastRepoReq?.source).toEqual({ type: 'local', path: '/tmp/foo' });
    expect(out.join('')).toMatch(/started ingest ing_/);
  });

  it('import-repo --url + --branch forwards git source', async () => {
    const { socketPath, ingest } = await spinUp();
    const code = await run({
      argv: [
        '--socket',
        socketPath,
        'import-repo',
        '--name',
        'my-app',
        '--url',
        'https://github.com/x/y.git',
        '--branch',
        'main',
      ],
      env: {},
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(ingest.lastRepoReq?.source).toEqual({
      type: 'git',
      cloneUrl: 'https://github.com/x/y.git',
      branch: 'main',
    });
  });

  it('import-repo without --path or --url returns 1', async () => {
    const { socketPath } = await spinUp();
    const err: string[] = [];
    const code = await run({
      argv: ['--socket', socketPath, 'import-repo', '--name', 'x'],
      env: {},
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(1);
    expect(err.join('')).toMatch(/--path/);
  });

  it('ingest-issues forwards repo + labels + state', async () => {
    const { socketPath, ingest } = await spinUp();
    const code = await run({
      argv: [
        '--socket',
        socketPath,
        'ingest-issues',
        '--repo',
        'my-team/mobile-client',
        '--labels',
        'bug,feature',
        '--state',
        'open',
        '--product',
        'mobile-app',
      ],
      env: {},
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(ingest.lastGithubReq?.repo).toBe('my-team/mobile-client');
    expect(ingest.lastGithubReq?.labels).toEqual(['bug', 'feature']);
    expect(ingest.lastGithubReq?.state).toBe('open');
    expect(ingest.lastGithubReq?.productId).toBe('mobile-app');
  });

  it('ingest-jira forwards JQL via --jql', async () => {
    const { socketPath, ingest } = await spinUp();
    const code = await run({
      argv: [
        '--socket',
        socketPath,
        'ingest-jira',
        '--jql',
        'project = MOBILE AND updated > -7d',
        '--max-results',
        '50',
      ],
      env: {},
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(ingest.lastJiraReq?.jql).toBe('project = MOBILE AND updated > -7d');
    expect(ingest.lastJiraReq?.maxResults).toBe(50);
  });

  it('ingest-confluence forwards space', async () => {
    const { socketPath, ingest } = await spinUp();
    const code = await run({
      argv: ['--socket', socketPath, 'ingest-confluence', '--space', 'ENG'],
      env: {},
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(ingest.lastConfluenceReq?.space).toBe('ENG');
  });

  it('ingest-issues without --repo returns 1', async () => {
    const { socketPath } = await spinUp();
    const err: string[] = [];
    const code = await run({
      argv: ['--socket', socketPath, 'ingest-issues'],
      env: {},
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(1);
    expect(err.join('')).toMatch(/--repo/);
  });

  it('crawl forwards URL via positional arg', async () => {
    const { socketPath, ingest } = await spinUp();
    const out: string[] = [];
    const code = await run({
      argv: ['--socket', socketPath, 'crawl', 'https://react.dev/changelog'],
      env: {},
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(ingest.lastCrawlReq?.url).toBe('https://react.dev/changelog');
    expect(out.join('')).toMatch(/started crawl/);
  });

  it('crawl honors --rate-limit + --product', async () => {
    const { socketPath, ingest } = await spinUp();
    const code = await run({
      argv: [
        '--socket',
        socketPath,
        'crawl',
        'https://example.com/page',
        '--rate-limit',
        '3',
        '--product',
        'web',
        '--name',
        'example-page',
      ],
      env: {},
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(ingest.lastCrawlReq?.rateLimitPerHost).toBe(3);
    expect(ingest.lastCrawlReq?.productId).toBe('web');
  });

  it('crawl without URL returns 1', async () => {
    const { socketPath } = await spinUp();
    const err: string[] = [];
    const code = await run({
      argv: ['--socket', socketPath, 'crawl'],
      env: {},
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(1);
    expect(err.join('')).toMatch(/url/i);
  });

  it('upload sends file via multipart and reports docId', async () => {
    const { socketPath, ingest } = await spinUp();
    const dir = await mkdtemp(join(tmpdir(), 'ctxcli-upload-'));
    const filePath = join(dir, 'spec.pdf');
    await writeFile(filePath, Buffer.from('%PDF-1.4 fake content'));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const out: string[] = [];
    const code = await run({
      argv: [
        '--socket',
        socketPath,
        'upload',
        filePath,
        '--description',
        'Mobile checkout',
        '--content-type',
        'application/pdf',
      ],
      env: {},
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(ingest.lastUploadReq?.filename).toBe('spec.pdf');
    expect(ingest.lastUploadReq?.contentType).toBe('application/pdf');
    expect(ingest.lastUploadReq?.description).toBe('Mobile checkout');
    expect(out.join('')).toMatch(/uploaded doc_/);
  });

  it('ingests (no args) lists all', async () => {
    const { socketPath, ingest } = await spinUp();
    ingest.ingests.set('ing_1', {
      ingestId: 'ing_1',
      kind: 'repo',
      state: 'completed',
      startedAt: '2026-05-07T00:00:00Z',
      events: [],
    });
    const out: string[] = [];
    const code = await run({
      argv: ['--socket', socketPath, 'ingests'],
      env: {},
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(out.join('')).toMatch(/ing_1/);
  });

  it('ingests <id> shows status', async () => {
    const { socketPath, ingest } = await spinUp();
    ingest.ingests.set('ing_42', {
      ingestId: 'ing_42',
      kind: 'repo',
      state: 'running',
      startedAt: '2026-05-07T00:00:00Z',
      events: [],
    });
    const out: string[] = [];
    const code = await run({
      argv: ['--socket', socketPath, 'ingests', 'ing_42'],
      env: {},
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(out.join('')).toMatch(/state=running/);
  });

  it('ingests --cancel <id>', async () => {
    const { socketPath, ingest } = await spinUp();
    ingest.ingests.set('ing_99', {
      ingestId: 'ing_99',
      kind: 'repo',
      state: 'running',
      startedAt: '2026-05-07T00:00:00Z',
      events: [],
    });
    const code = await run({
      argv: ['--socket', socketPath, 'ingests', 'ing_99', '--cancel'],
      env: {},
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(ingest.ingests.get('ing_99')?.state).toBe('cancelled');
  });

  it('uploads (no args) lists', async () => {
    const { socketPath, ingest } = await spinUp();
    ingest.uploads.set('doc_x', {
      docId: 'doc_x',
      filename: 'x.pdf',
      contentType: 'application/pdf',
      sizeBytes: 100,
      uploadedAt: '2026-05-07T00:00:00Z',
      localPath: '/tmp/x',
    });
    const out: string[] = [];
    const code = await run({
      argv: ['--socket', socketPath, 'uploads'],
      env: {},
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(out.join('')).toMatch(/doc_x/);
    expect(out.join('')).toMatch(/x\.pdf/);
  });

  it('uploads <docId> --delete', async () => {
    const { socketPath, ingest } = await spinUp();
    ingest.uploads.set('doc_d', {
      docId: 'doc_d',
      filename: 'd.pdf',
      contentType: 'application/pdf',
      sizeBytes: 50,
      uploadedAt: '2026-05-07T00:00:00Z',
      localPath: '/tmp/d',
    });
    const code = await run({
      argv: ['--socket', socketPath, 'uploads', 'doc_d', '--delete'],
      env: {},
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(ingest.uploads.has('doc_d')).toBe(false);
  });

  it('metrics returns Prometheus text', async () => {
    const { socketPath } = await spinUp();
    const out: string[] = [];
    const code = await run({
      argv: ['--socket', socketPath, 'metrics'],
      env: {},
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(out.join('')).toMatch(/edge_context_uptime_seconds/);
  });
});

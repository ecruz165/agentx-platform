/**
 * Stub-backed tests for the ingest routes + WebSocket event stream +
 * metrics endpoint. The IngestService is mocked here just like
 * StubQueryService mocks QueryService — so tests don't need Neo4j or
 * a real loader pipeline.
 *
 * Real-loader / real-Neo4j integration is left to a follow-up gated
 * test (RUN_NEO4J_INTEGRATION=1) that drives a small fixture repo.
 */

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startContextServer } from './index.ts';
import type {
  CrawlIngestRequest,
  EventCallback,
  IngestService,
  IngestStatus,
  RepoIngestRequest,
  UploadEntry,
  UploadIngestRequest,
} from './ingest.ts';
import type {
  ConfluenceIngestRequest,
  GithubIssuesIngestRequest,
  JiraIngestRequest,
} from './external-sources.ts';

const tmpSocket = () => join(tmpdir(), `ctx-ing-${randomUUID().slice(0, 8)}.sock`);

interface UdsResponse {
  status: number;
  body: any;
}
function udsJson(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
  contentType = 'application/json',
): Promise<UdsResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path, method, headers: body ? { 'content-type': contentType } : {} },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c.toString()));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: buf
              ? res.headers['content-type']?.includes('json')
                ? JSON.parse(buf)
                : buf
              : null,
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

class StubIngestService implements IngestService {
  ingests = new Map<string, IngestStatus>();
  uploads = new Map<string, UploadEntry>();
  subscribers = new Map<string, Set<EventCallback>>();
  closed = false;

  async startRepoIngest(req: RepoIngestRequest): Promise<{ ingestId: string }> {
    const ingestId = `ing_${Math.random().toString(36).slice(2, 10)}`;
    const status: IngestStatus = {
      ingestId,
      kind: 'repo',
      state: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      productId: req.productId,
      summary: { filesIngested: 5, chunksWritten: 12, vectorsWritten: 12, errors: 0, durationMs: 100 },
      events: [
        { kind: 'source-resolved', source: { kind: 'path', path: '/tmp/x' }, itemCount: 5 },
        {
          kind: 'source-completed',
          filesIngested: 5,
          chunksWritten: 12,
          vectorsWritten: 12,
          errors: 0,
        },
      ],
    };
    this.ingests.set(ingestId, status);
    return { ingestId };
  }

  lastCrawlReq?: CrawlIngestRequest;
  lastGithubReq?: GithubIssuesIngestRequest;
  lastJiraReq?: JiraIngestRequest;
  lastConfluenceReq?: ConfluenceIngestRequest;

  async startJiraIngest(req: JiraIngestRequest): Promise<{ ingestId: string }> {
    this.lastJiraReq = req;
    const ingestId = `ing_jira_${Math.random().toString(36).slice(2, 8)}`;
    this.ingests.set(ingestId, {
      ingestId,
      kind: 'jira',
      state: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      productId: req.productId,
      summary: { filesIngested: 7, chunksWritten: 7, vectorsWritten: 7, errors: 0, durationMs: 30 },
      events: [],
    });
    return { ingestId };
  }

  async startConfluenceIngest(req: ConfluenceIngestRequest): Promise<{ ingestId: string }> {
    this.lastConfluenceReq = req;
    const ingestId = `ing_conf_${Math.random().toString(36).slice(2, 8)}`;
    this.ingests.set(ingestId, {
      ingestId,
      kind: 'confluence',
      state: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      productId: req.productId,
      summary: { filesIngested: 12, chunksWritten: 12, vectorsWritten: 12, errors: 0, durationMs: 60 },
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
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      productId: req.productId,
      summary: { filesIngested: 4, chunksWritten: 4, vectorsWritten: 4, errors: 0, durationMs: 25 },
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
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      productId: req.productId,
      summary: { filesIngested: 1, chunksWritten: 4, vectorsWritten: 4, errors: 0, durationMs: 50 },
      events: [],
    });
    return { ingestId };
  }

  async startUploadIngest(
    req: UploadIngestRequest,
  ): Promise<{ ingestId: string; entry: UploadEntry }> {
    const ingestId = `ing_${Math.random().toString(36).slice(2, 10)}`;
    const docId = `doc_${ingestId.slice(4)}`;
    const entry: UploadEntry = {
      docId,
      filename: req.filename,
      contentType: req.contentType ?? 'application/octet-stream',
      sizeBytes: req.bytes.byteLength,
      uploadedAt: new Date().toISOString(),
      localPath: `/tmp/uploads/${docId}/${req.filename}`,
      productId: req.productId,
      description: req.description,
    };
    this.uploads.set(docId, entry);
    this.ingests.set(ingestId, {
      ingestId,
      kind: 'upload',
      state: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      summary: { filesIngested: 1, chunksWritten: 0, vectorsWritten: 0, errors: 0, durationMs: 1 },
      events: [{ kind: 'node-written', nodeId: docId, label: 'Doc' }],
    });
    return { ingestId, entry };
  }

  getIngest(id: string): IngestStatus | undefined {
    return this.ingests.get(id);
  }
  listIngests(): IngestStatus[] {
    return [...this.ingests.values()];
  }
  cancelIngest(id: string): boolean {
    const s = this.ingests.get(id);
    if (!s) return false;
    s.state = 'cancelled';
    return true;
  }
  subscribe(ingestId: string, cb: EventCallback): () => void {
    let subs = this.subscribers.get(ingestId);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(ingestId, subs);
    }
    subs.add(cb);
    return () => subs?.delete(cb);
  }
  /** Test helper — push an event into a live ingest. */
  pushEvent(ingestId: string, event: Parameters<EventCallback>[0]): void {
    const subs = this.subscribers.get(ingestId);
    if (subs) for (const cb of subs) cb(event);
    const s = this.ingests.get(ingestId);
    if (s) s.events.push(event);
  }
  async listUploads(productId?: string): Promise<UploadEntry[]> {
    const all = [...this.uploads.values()];
    return productId ? all.filter((u) => u.productId === productId) : all;
  }
  async deleteUpload(docId: string): Promise<boolean> {
    return this.uploads.delete(docId);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

describe('edge-context-server — ingest routes', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function spinUp(stub?: StubIngestService) {
    const ingest = stub ?? new StubIngestService();
    const socketPath = tmpSocket();
    const handle = await startContextServer({ socketPath, ingest, idleThrottleMs: 0 });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });
    return { socketPath, ingest };
  }

  it('POST /v1/ingest/repo (local) → 202 + ingestId', async () => {
    const { socketPath } = await spinUp();
    const r = await udsJson(socketPath, 'POST', '/v1/ingest/repo', {
      name: 'my-app',
      source: { type: 'local', path: '/tmp/my-app' },
      productId: 'web',
    });
    expect(r.status).toBe(202);
    expect(r.body.ingestId).toMatch(/^ing_/);
  });

  it('POST /v1/ingest/repo (git) → 202', async () => {
    const { socketPath } = await spinUp();
    const r = await udsJson(socketPath, 'POST', '/v1/ingest/repo', {
      name: 'my-app',
      source: { type: 'git', cloneUrl: 'https://x/y.git', branch: 'main' },
    });
    expect(r.status).toBe(202);
  });

  it('POST /v1/ingest/repo with bad source.type → 400', async () => {
    const { socketPath } = await spinUp();
    const r = await udsJson(socketPath, 'POST', '/v1/ingest/repo', {
      name: 'x',
      source: { type: 'banana' },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/source.type/);
  });

  it('POST /v1/ingest/repo without ingest backend → 503', async () => {
    const socketPath = tmpSocket();
    const handle = await startContextServer({ socketPath, idleThrottleMs: 0 });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });
    const r = await udsJson(socketPath, 'POST', '/v1/ingest/repo', {
      name: 'x',
      source: { type: 'local', path: '/tmp' },
    });
    expect(r.status).toBe(503);
  });

  it('GET /v1/ingest/<id> returns status', async () => {
    const { socketPath, ingest } = await spinUp();
    const start = await udsJson(socketPath, 'POST', '/v1/ingest/repo', {
      name: 'x',
      source: { type: 'local', path: '/tmp' },
    });
    const id = start.body.ingestId;
    const r = await udsJson(socketPath, 'GET', `/v1/ingest/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.status.state).toBe('completed');
    expect(r.body.status.summary.filesIngested).toBe(5);
    expect(ingest.ingests.size).toBe(1);
  });

  it('GET /v1/ingest/<id> for unknown id → 404', async () => {
    const { socketPath } = await spinUp();
    const r = await udsJson(socketPath, 'GET', '/v1/ingest/ing_nope');
    expect(r.status).toBe(404);
  });

  it('DELETE /v1/ingest/<id> cancels', async () => {
    const { socketPath } = await spinUp();
    const start = await udsJson(socketPath, 'POST', '/v1/ingest/repo', {
      name: 'x',
      source: { type: 'local', path: '/tmp' },
    });
    const id = start.body.ingestId;
    const r = await udsJson(socketPath, 'DELETE', `/v1/ingest/${id}`);
    expect(r.status).toBe(204);
    const status = await udsJson(socketPath, 'GET', `/v1/ingest/${id}`);
    expect(status.body.status.state).toBe('cancelled');
  });

  it('GET /v1/ingest lists all ingests', async () => {
    const { socketPath } = await spinUp();
    await udsJson(socketPath, 'POST', '/v1/ingest/repo', {
      name: 'a',
      source: { type: 'local', path: '/tmp/a' },
    });
    await udsJson(socketPath, 'POST', '/v1/ingest/repo', {
      name: 'b',
      source: { type: 'local', path: '/tmp/b' },
    });
    const r = await udsJson(socketPath, 'GET', '/v1/ingest');
    expect(r.body.ingests).toHaveLength(2);
  });

  it('POST /v1/ingest/upload (multipart) → 202 + entry', async () => {
    const { socketPath, ingest } = await spinUp();
    const boundary = '----testboundary123';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(
        'Content-Disposition: form-data; name="description"\r\n\r\nMobile checkout v2\r\n',
      ),
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(
        'Content-Disposition: form-data; name="file"; filename="design.pdf"\r\n',
      ),
      Buffer.from('Content-Type: application/pdf\r\n\r\n'),
      Buffer.from('%PDF-1.4 fake pdf bytes'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await udsJson(
      socketPath,
      'POST',
      '/v1/ingest/upload',
      body.toString('binary'),
      `multipart/form-data; boundary=${boundary}`,
    );
    expect(r.status).toBe(202);
    expect(r.body.entry.filename).toBe('design.pdf');
    expect(r.body.entry.contentType).toBe('application/pdf');
    expect(r.body.entry.description).toBe('Mobile checkout v2');
    expect(ingest.uploads.size).toBe(1);
  });

  it('POST /v1/ingest/github-issues forwards args + returns 202', async () => {
    const { socketPath, ingest } = await spinUp();
    const r = await udsJson(socketPath, 'POST', '/v1/ingest/github-issues', {
      name: 'mobile-issues',
      repo: 'my-team/mobile-client',
      labels: ['bug', 'priority-1'],
      state: 'open',
      productId: 'mobile-app',
    });
    expect(r.status).toBe(202);
    expect(r.body.ingestId).toMatch(/^ing_/);
    expect(ingest.lastGithubReq?.repo).toBe('my-team/mobile-client');
    expect(ingest.lastGithubReq?.labels).toEqual(['bug', 'priority-1']);
    expect(ingest.lastGithubReq?.state).toBe('open');
  });

  it('POST /v1/ingest/jira forwards JQL + returns 202', async () => {
    const { socketPath, ingest } = await spinUp();
    const r = await udsJson(socketPath, 'POST', '/v1/ingest/jira', {
      name: 'mobile-issues',
      jql: 'project = MOBILE AND updated > -7d',
      maxResults: 50,
      productId: 'mobile-app',
    });
    expect(r.status).toBe(202);
    expect(ingest.lastJiraReq?.jql).toBe('project = MOBILE AND updated > -7d');
    expect(ingest.lastJiraReq?.maxResults).toBe(50);
  });

  it('POST /v1/ingest/jira missing jql → 400', async () => {
    const { socketPath } = await spinUp();
    const r = await udsJson(socketPath, 'POST', '/v1/ingest/jira', { name: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/jql/);
  });

  it('POST /v1/ingest/confluence forwards space + returns 202', async () => {
    const { socketPath, ingest } = await spinUp();
    const r = await udsJson(socketPath, 'POST', '/v1/ingest/confluence', {
      name: 'eng-docs',
      space: 'ENG',
      productId: 'web',
    });
    expect(r.status).toBe(202);
    expect(ingest.lastConfluenceReq?.space).toBe('ENG');
  });

  it('POST /v1/ingest/confluence missing space → 400', async () => {
    const { socketPath } = await spinUp();
    const r = await udsJson(socketPath, 'POST', '/v1/ingest/confluence', { name: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/space/);
  });

  it('POST /v1/ingest/github-issues missing repo → 400', async () => {
    const { socketPath } = await spinUp();
    const r = await udsJson(socketPath, 'POST', '/v1/ingest/github-issues', { name: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/repo/);
  });

  it('POST /v1/ingest/crawl forwards args + returns 202', async () => {
    const { socketPath, ingest } = await spinUp();
    const r = await udsJson(socketPath, 'POST', '/v1/ingest/crawl', {
      name: 'react-changelog',
      url: 'https://react.dev/changelog',
      productId: 'web',
      rateLimitPerHost: 2,
    });
    expect(r.status).toBe(202);
    expect(r.body.ingestId).toMatch(/^ing_/);
    expect(ingest.lastCrawlReq?.url).toBe('https://react.dev/changelog');
    expect(ingest.lastCrawlReq?.rateLimitPerHost).toBe(2);
  });

  it('POST /v1/ingest/crawl missing url → 400', async () => {
    const { socketPath } = await spinUp();
    const r = await udsJson(socketPath, 'POST', '/v1/ingest/crawl', { name: 'x' });
    expect(r.status).toBe(400);
  });

  it('POST /v1/ingest/upload with no file part → 400', async () => {
    const { socketPath } = await spinUp();
    const boundary = '----xx';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from('Content-Disposition: form-data; name="description"\r\n\r\nno file\r\n'),
      Buffer.from(`--${boundary}--\r\n`),
    ]);
    const r = await udsJson(
      socketPath,
      'POST',
      '/v1/ingest/upload',
      body.toString('binary'),
      `multipart/form-data; boundary=${boundary}`,
    );
    expect(r.status).toBe(400);
  });

  it('GET /v1/uploads lists stored uploads', async () => {
    const { socketPath, ingest } = await spinUp();
    ingest.uploads.set('doc_1', {
      docId: 'doc_1',
      filename: 'a.pdf',
      contentType: 'application/pdf',
      sizeBytes: 100,
      uploadedAt: '2026-05-07T00:00:00Z',
      localPath: '/tmp/x/a.pdf',
    });
    const r = await udsJson(socketPath, 'GET', '/v1/uploads');
    expect(r.body.uploads).toHaveLength(1);
    expect(r.body.uploads[0].docId).toBe('doc_1');
  });

  it('DELETE /v1/uploads/<docId> removes upload', async () => {
    const { socketPath, ingest } = await spinUp();
    ingest.uploads.set('doc_2', {
      docId: 'doc_2',
      filename: 'b.pdf',
      contentType: 'application/pdf',
      sizeBytes: 50,
      uploadedAt: '2026-05-07T00:00:00Z',
      localPath: '/tmp/y/b.pdf',
    });
    const r = await udsJson(socketPath, 'DELETE', '/v1/uploads/doc_2');
    expect(r.status).toBe(204);
    expect(ingest.uploads.has('doc_2')).toBe(false);
  });
});

describe('edge-context-server — WebSocket /v1/ingest/events', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('streams events for a subscribed ingest', async () => {
    const ingest = new StubIngestService();
    const socketPath = tmpSocket();
    const handle = await startContextServer({ socketPath, ingest, idleThrottleMs: 0 });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });

    // Seed an in-flight ingest
    const status: IngestStatus = {
      ingestId: 'ing_live',
      kind: 'repo',
      state: 'running',
      startedAt: new Date().toISOString(),
      events: [],
    };
    ingest.ingests.set('ing_live', status);

    const ws = new WebSocket(`ws+unix://${socketPath}:/v1/ingest/events`);
    const events: Array<Record<string, unknown>> = [];
    // Attach message handler BEFORE waiting for open — server sends a
    // welcome immediately on upgrade, so the handler must be in place.
    ws.on('message', (data) => events.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    // Brief tick for welcome to land in the handler.
    await new Promise((r) => setTimeout(r, 50));
    expect(events.some((e) => e.welcome)).toBe(true);

    // Push an event — should be forwarded
    ingest.pushEvent('ing_live', {
      kind: 'item-walked',
      itemId: 'src/foo.ts',
      itemType: 'file',
      sizeBytes: 100,
    });
    await new Promise((r) => setTimeout(r, 50));
    const evMsg = events.find(
      (e) => e.event && (e.event as { kind: string }).kind === 'item-walked',
    );
    expect(evMsg).toBeTruthy();

    ws.close();
    await new Promise((r) => setTimeout(r, 30));
  });
});

describe('edge-context-server — /metrics + /openapi.json', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('GET /metrics returns Prometheus text', async () => {
    const socketPath = tmpSocket();
    const handle = await startContextServer({
      socketPath,
      ingest: new StubIngestService(),
      idleThrottleMs: 0,
    });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });
    const r = await udsJson(socketPath, 'GET', '/metrics');
    expect(r.status).toBe(200);
    expect(typeof r.body).toBe('string');
    expect(r.body).toContain('edge_context_uptime_seconds');
    expect(r.body).toContain('edge_context_requests_total');
  });

  it('GET /openapi.json returns OpenAPI 3.1 spec', async () => {
    const socketPath = tmpSocket();
    const handle = await startContextServer({ socketPath, idleThrottleMs: 0 });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });
    const r = await udsJson(socketPath, 'GET', '/openapi.json');
    expect(r.status).toBe(200);
    expect(r.body.openapi).toBe('3.1.0');
    expect(r.body.paths['/v1/traverse']).toBeTruthy();
    expect(r.body.paths['/v1/ingest/repo']).toBeTruthy();
  });
});

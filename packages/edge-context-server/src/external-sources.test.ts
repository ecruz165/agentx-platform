/**
 * Unit tests for the GitHub Issues fetcher. Stubs fetch + env so no
 * real network or auth is needed. Covers:
 *   - missing GITHUB_TOKEN → clear error
 *   - invalid repo format → reject before any HTTP
 *   - 401/403/rate-limit → mapped to actionable messages
 *   - PR vs Issue filtering (GitHub returns both via /issues by default)
 *   - pagination termination on short page
 *   - label/state/since query-param shaping
 */

import { describe, expect, it } from 'vitest';
import {
  ConfluenceFetcher,
  type ConfluencePage,
  GithubIssuesFetcher,
  type GithubIssue,
  JiraFetcher,
  type JiraIssue,
} from './external-sources.ts';

function makeIssue(overrides: Partial<GithubIssue> = {}): GithubIssue {
  return {
    id: 1,
    number: 1,
    title: 'Sample',
    body: 'Body',
    state: 'open',
    labels: [],
    user: { login: 'me' },
    created_at: '2026-05-08T00:00:00Z',
    updated_at: '2026-05-08T00:00:00Z',
    html_url: 'https://github.com/x/y/issues/1',
    ...overrides,
  };
}

function fakeFetch(handler: (url: string, init: RequestInit | undefined) => Response): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : input.toString();
    return Promise.resolve(handler(u, init));
  }) as typeof fetch;
}

describe('GithubIssuesFetcher', () => {
  it('throws when GITHUB_TOKEN is missing', async () => {
    const f = new GithubIssuesFetcher({
      fetchImpl: fakeFetch(() => new Response('[]')),
      envGet: () => undefined,
    });
    const it = f.fetchIssues({ name: 'x', repo: 'org/r' })[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it('rejects malformed repo before any HTTP call', async () => {
    let calls = 0;
    const f = new GithubIssuesFetcher({
      fetchImpl: fakeFetch(() => {
        calls += 1;
        return new Response('[]');
      }),
      envGet: (k) => (k === 'GITHUB_TOKEN' ? 't' : undefined),
    });
    const iter = f.fetchIssues({ name: 'x', repo: 'no-slash' })[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(/repo format/);
    expect(calls).toBe(0);
  });

  it('maps 401 to a token-check error', async () => {
    const f = new GithubIssuesFetcher({
      fetchImpl: fakeFetch(() => new Response('unauthorized', { status: 401 })),
      envGet: (k) => (k === 'GITHUB_TOKEN' ? 'bad' : undefined),
    });
    const iter = f.fetchIssues({ name: 'x', repo: 'org/r' })[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it('maps 403 + remaining=0 to a rate-limit error', async () => {
    const f = new GithubIssuesFetcher({
      fetchImpl: fakeFetch(
        () => new Response('rate limited', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      ),
      envGet: (k) => (k === 'GITHUB_TOKEN' ? 't' : undefined),
    });
    const iter = f.fetchIssues({ name: 'x', repo: 'org/r' })[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(/rate limit/);
  });

  it('filters out pull requests', async () => {
    const f = new GithubIssuesFetcher({
      fetchImpl: fakeFetch(
        () =>
          new Response(
            JSON.stringify([
              makeIssue({ number: 1 }),
              makeIssue({ number: 2, pull_request: { url: 'pr' } }),
              makeIssue({ number: 3 }),
            ]),
            { status: 200 },
          ),
      ),
      envGet: (k) => (k === 'GITHUB_TOKEN' ? 't' : undefined),
    });
    const issues: GithubIssue[] = [];
    for await (const issue of f.fetchIssues({ name: 'x', repo: 'org/r' })) {
      issues.push(issue);
    }
    expect(issues.map((i) => i.number)).toEqual([1, 3]);
  });

  it('terminates pagination on short page (<100)', async () => {
    let pageCount = 0;
    const f = new GithubIssuesFetcher({
      fetchImpl: fakeFetch(() => {
        pageCount += 1;
        return new Response(JSON.stringify([makeIssue({ number: pageCount })]), { status: 200 });
      }),
      envGet: (k) => (k === 'GITHUB_TOKEN' ? 't' : undefined),
    });
    const issues: GithubIssue[] = [];
    for await (const issue of f.fetchIssues({ name: 'x', repo: 'org/r', maxPages: 5 })) {
      issues.push(issue);
    }
    expect(pageCount).toBe(1);
    expect(issues).toHaveLength(1);
  });

  it('passes labels + state + since as query params', async () => {
    let capturedUrl = '';
    const f = new GithubIssuesFetcher({
      fetchImpl: fakeFetch((url) => {
        capturedUrl = url;
        return new Response('[]', { status: 200 });
      }),
      envGet: (k) => (k === 'GITHUB_TOKEN' ? 't' : undefined),
    });
    const iter = f.fetchIssues({
      name: 'x',
      repo: 'org/r',
      labels: ['bug', 'priority-1'],
      state: 'open',
      since: '2026-01-01T00:00:00Z',
    })[Symbol.asyncIterator]();
    await iter.next();
    expect(capturedUrl).toContain('labels=bug%2Cpriority-1');
    expect(capturedUrl).toContain('state=open');
    expect(capturedUrl).toContain('since=2026-01-01T00%3A00%3A00Z');
  });

  it('sends Authorization header with bearer token', async () => {
    let capturedAuth = '';
    const f = new GithubIssuesFetcher({
      fetchImpl: fakeFetch((_url, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        capturedAuth = headers['authorization'] ?? '';
        return new Response('[]', { status: 200 });
      }),
      envGet: (k) => (k === 'GITHUB_TOKEN' ? 'mytoken' : undefined),
    });
    const iter = f.fetchIssues({ name: 'x', repo: 'org/r' })[Symbol.asyncIterator]();
    await iter.next();
    expect(capturedAuth).toBe('Bearer mytoken');
  });

  it('honors GITHUB_API_BASE override (for GHES)', async () => {
    let capturedUrl = '';
    const f = new GithubIssuesFetcher({
      fetchImpl: fakeFetch((url) => {
        capturedUrl = url;
        return new Response('[]', { status: 200 });
      }),
      envGet: (k) => {
        if (k === 'GITHUB_TOKEN') return 't';
        if (k === 'GITHUB_API_BASE') return 'https://github.example.com/api/v3';
        return undefined;
      },
    });
    const iter = f.fetchIssues({ name: 'x', repo: 'org/r' })[Symbol.asyncIterator]();
    await iter.next();
    expect(capturedUrl).toMatch(/^https:\/\/github\.example\.com\/api\/v3\//);
  });
});

describe('JiraFetcher', () => {
  function fakeFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : input.toString();
      return Promise.resolve(handler(u, init));
    }) as typeof fetch;
  }
  function jiraEnv(extra: Record<string, string> = {}): (k: string) => string | undefined {
    const map: Record<string, string> = {
      JIRA_TOKEN: 'tok',
      JIRA_EMAIL: 'me@example.com',
      JIRA_BASE_URL: 'https://myorg.atlassian.net',
      ...extra,
    };
    return (k) => map[k];
  }
  function makeIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
    return {
      id: '10001',
      key: 'MOB-1',
      fields: {
        summary: 'Test',
        description: null,
        status: { name: 'Open' },
        issuetype: { name: 'Bug' },
        priority: { name: 'High' },
        labels: [],
        assignee: null,
        reporter: { displayName: 'me' },
        created: '2026-05-08T00:00:00Z',
        updated: '2026-05-08T00:00:00Z',
      },
      ...overrides,
    };
  }

  it('throws when JIRA_TOKEN is missing', async () => {
    const f = new JiraFetcher({
      fetchImpl: fakeFetch(() => new Response('{}')),
      envGet: () => undefined,
    });
    const iter = f.fetchIssues({ name: 'x', jql: 'project=X' })[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(/JIRA_TOKEN/);
  });

  it('uses Basic auth (email:token) by default', async () => {
    let captured = '';
    const f = new JiraFetcher({
      fetchImpl: fakeFetch((_u, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        captured = headers['authorization'] ?? '';
        return new Response(JSON.stringify({ issues: [], total: 0, startAt: 0 }), { status: 200 });
      }),
      envGet: jiraEnv(),
    });
    const iter = f.fetchIssues({ name: 'x', jql: 'project=X' })[Symbol.asyncIterator]();
    await iter.next();
    const expected = `Basic ${Buffer.from('me@example.com:tok').toString('base64')}`;
    expect(captured).toBe(expected);
  });

  it('switches to Bearer when JIRA_AUTH_SCHEME=Bearer (self-hosted)', async () => {
    let captured = '';
    const f = new JiraFetcher({
      fetchImpl: fakeFetch((_u, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        captured = headers['authorization'] ?? '';
        return new Response(JSON.stringify({ issues: [], total: 0, startAt: 0 }), { status: 200 });
      }),
      envGet: jiraEnv({ JIRA_AUTH_SCHEME: 'Bearer' }),
    });
    const iter = f.fetchIssues({ name: 'x', jql: 'project=X' })[Symbol.asyncIterator]();
    await iter.next();
    expect(captured).toBe('Bearer tok');
  });

  it('passes JQL + fields as query params', async () => {
    let capturedUrl = '';
    const f = new JiraFetcher({
      fetchImpl: fakeFetch((url) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ issues: [], total: 0, startAt: 0 }), { status: 200 });
      }),
      envGet: jiraEnv(),
    });
    const iter = f.fetchIssues({
      name: 'x',
      jql: 'project = MOBILE',
      fields: ['summary', 'status'],
    })[Symbol.asyncIterator]();
    await iter.next();
    expect(capturedUrl).toContain('jql=project+%3D+MOBILE');
    expect(capturedUrl).toContain('fields=summary%2Cstatus');
  });

  it('terminates pagination when issues < pageSize', async () => {
    let pageCount = 0;
    const f = new JiraFetcher({
      fetchImpl: fakeFetch(() => {
        pageCount += 1;
        return new Response(
          JSON.stringify({ issues: [makeIssue({ key: `MOB-${pageCount}` })], total: 1, startAt: 0 }),
          { status: 200 },
        );
      }),
      envGet: jiraEnv(),
    });
    const issues: JiraIssue[] = [];
    for await (const i of f.fetchIssues({ name: 'x', jql: 'project=X', maxResults: 200 })) {
      issues.push(i);
    }
    expect(pageCount).toBe(1);
    expect(issues).toHaveLength(1);
  });
});

describe('ConfluenceFetcher', () => {
  function fakeFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : input.toString();
      return Promise.resolve(handler(u, init));
    }) as typeof fetch;
  }
  function conflEnv(extra: Record<string, string> = {}): (k: string) => string | undefined {
    const map: Record<string, string> = {
      CONFLUENCE_TOKEN: 'tok',
      CONFLUENCE_EMAIL: 'me@example.com',
      CONFLUENCE_BASE_URL: 'https://myorg.atlassian.net',
      ...extra,
    };
    return (k) => map[k];
  }
  function makePage(overrides: Partial<ConfluencePage> = {}): ConfluencePage {
    return {
      id: '111',
      title: 'Page',
      body: { storage: { value: '<p>hello</p>' } },
      status: 'current',
      createdAt: '2026-05-08T00:00:00Z',
      version: { number: 1, createdAt: '2026-05-08T00:00:00Z' },
      _links: { webui: '/spaces/ENG/pages/111' },
      ...overrides,
    };
  }

  it('throws when env vars missing', async () => {
    const f = new ConfluenceFetcher({
      fetchImpl: fakeFetch(() => new Response('{}')),
      envGet: () => undefined,
    });
    const iter = f.fetchPages({ name: 'x', space: 'ENG' })[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(/CONFLUENCE_TOKEN/);
  });

  it('returns 404 message when space not found', async () => {
    const f = new ConfluenceFetcher({
      fetchImpl: fakeFetch(() => new Response('{}', { status: 404 })),
      envGet: conflEnv(),
    });
    const iter = f.fetchPages({ name: 'x', space: 'NOPE' })[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(/not found/);
  });

  it('follows _links.next for pagination', async () => {
    let calls = 0;
    const f = new ConfluenceFetcher({
      fetchImpl: fakeFetch((url) => {
        calls += 1;
        if (url.includes('cursor=2')) {
          return new Response(JSON.stringify({ results: [makePage({ id: '222' })] }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({
            results: [makePage({ id: '111' })],
            _links: { next: '/api/v2/spaces/ENG/pages?cursor=2' },
          }),
          { status: 200 },
        );
      }),
      envGet: conflEnv(),
    });
    const ids: string[] = [];
    for await (const p of f.fetchPages({ name: 'x', space: 'ENG', maxResults: 50 })) {
      ids.push(p.id);
    }
    expect(calls).toBe(2);
    expect(ids).toEqual(['111', '222']);
  });

  it('honors maxResults cap', async () => {
    const f = new ConfluenceFetcher({
      fetchImpl: fakeFetch(() => {
        const results = Array.from({ length: 100 }, (_, i) => makePage({ id: String(i) }));
        return new Response(
          JSON.stringify({ results, _links: { next: '/api/v2/spaces/ENG/pages?cursor=2' } }),
          { status: 200 },
        );
      }),
      envGet: conflEnv(),
    });
    const pages: ConfluencePage[] = [];
    for await (const p of f.fetchPages({ name: 'x', space: 'ENG', maxResults: 5 })) {
      pages.push(p);
    }
    expect(pages).toHaveLength(5);
  });
});

/**
 * Crawler unit tests — exercises the readability extractor, robots.txt
 * parser/matcher, and the rate-limit-aware fetch path. Uses a fake
 * fetch impl so no real network calls are made.
 */

import { describe, expect, it } from 'vitest';
import { Crawler, __test__ } from './crawl.ts';

const {
  extractReadable,
  parseRobotsTxt,
  isAllowed,
  extractLinks,
  parseSitemap,
  isAllowedHost,
  canonicalize,
  subtreeBoundary,
} = __test__;

describe('extractReadable', () => {
  it('extracts title + main content', () => {
    const html = `
      <html>
        <head><title>React docs</title></head>
        <body>
          <nav>useless nav</nav>
          <main>
            <h1>Hooks</h1>
            <p>useState lets you add state to function components.</p>
            <h2>Why</h2>
            <p>Because classes are awkward.</p>
          </main>
          <footer>useless footer</footer>
        </body>
      </html>
    `;
    const r = extractReadable(html);
    expect(r.title).toBe('React docs');
    expect(r.markdown).toContain('# Hooks');
    expect(r.markdown).toContain('## Why');
    expect(r.markdown).toContain('useState');
    expect(r.markdown).not.toContain('useless nav');
    expect(r.markdown).not.toContain('useless footer');
  });

  it('falls back to <article> when <main> is missing', () => {
    const html = `
      <html><head><title>X</title></head>
      <body><article><h1>Article</h1><p>Body</p></article></body></html>
    `;
    const r = extractReadable(html);
    expect(r.markdown).toContain('# Article');
    expect(r.markdown).toContain('Body');
  });

  it('decodes HTML entities', () => {
    const html = '<html><body><p>foo &amp; bar &lt;baz&gt; &#39;quoted&#39;</p></body></html>';
    const r = extractReadable(html);
    expect(r.markdown).toContain("foo & bar <baz> 'quoted'");
  });

  it('preserves <pre> as fenced code', () => {
    const html = `<html><body><main><pre>const x = 1;</pre></main></body></html>`;
    const r = extractReadable(html);
    expect(r.markdown).toContain('```');
    expect(r.markdown).toContain('const x = 1;');
  });

  it('strips script + style', () => {
    const html = `
      <html><body>
        <script>alert('xss')</script>
        <style>body { display: none; }</style>
        <main><p>real content</p></main>
      </body></html>
    `;
    const r = extractReadable(html);
    expect(r.markdown).toContain('real content');
    expect(r.markdown).not.toContain('alert');
    expect(r.markdown).not.toContain('display: none');
  });
});

describe('robots.txt parsing + matching', () => {
  it('parses simple Allow/Disallow', () => {
    const txt = `
      User-agent: *
      Disallow: /admin
      Allow: /admin/public
    `;
    const r = parseRobotsTxt(txt);
    expect(r.userAgents['*']).toBeTruthy();
    expect(r.userAgents['*'].disallow).toContain('/admin');
    expect(r.userAgents['*'].allow).toContain('/admin/public');
  });

  it('isAllowed honors longest-match Allow over Disallow', () => {
    const r = parseRobotsTxt(`
      User-agent: *
      Disallow: /admin
      Allow: /admin/public
    `);
    expect(isAllowed(r, 'edge-context', '/admin/secret')).toBe(false);
    expect(isAllowed(r, 'edge-context', '/admin/public/ok')).toBe(true);
    expect(isAllowed(r, 'edge-context', '/')).toBe(true);
  });

  it('handles wildcard patterns', () => {
    const r = parseRobotsTxt(`
      User-agent: *
      Disallow: /api/*/secret$
    `);
    expect(isAllowed(r, 'x', '/api/v1/secret')).toBe(false);
    expect(isAllowed(r, 'x', '/api/v1/public')).toBe(true);
  });

  it('matches user-agent by substring', () => {
    const r = parseRobotsTxt(`
      User-agent: googlebot
      Disallow: /

      User-agent: *
      Allow: /
    `);
    expect(isAllowed(r, 'googlebot/2.1', '/anything')).toBe(false);
    expect(isAllowed(r, 'edge-context', '/anything')).toBe(true);
  });

  it('empty or missing robots.txt → permissive', () => {
    const r = parseRobotsTxt('');
    expect(isAllowed(r, 'x', '/anything')).toBe(true);
  });
});

describe('Crawler.crawl', () => {
  function fakeFetch(handler: (url: string) => Response): typeof fetch {
    return ((input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : input.toString();
      return Promise.resolve(handler(u));
    }) as typeof fetch;
  }

  function htmlResponse(body: string, init: ResponseInit = {}): Response {
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/html', ...((init.headers as Record<string, string>) ?? {}) },
      ...init,
    });
  }

  it('fetches + extracts a simple HTML page', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
      return htmlResponse(`<html><head><title>Hi</title></head><body><main><h1>X</h1><p>Y</p></main></body></html>`);
    });
    const c = new Crawler({ fetchImpl });
    const r = await c.crawl({ url: 'https://example.com/page' });
    expect(r.status).toBe(200);
    expect(r.title).toBe('Hi');
    expect(r.contentMarkdown).toContain('# X');
    expect(r.contentHash).toMatch(/^[a-f0-9]+$/);
  });

  it('honors robots.txt Disallow', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.endsWith('/robots.txt'))
        return new Response('User-agent: *\nDisallow: /private', { status: 200 });
      return htmlResponse(`<html><body>secret</body></html>`);
    });
    const c = new Crawler({ fetchImpl });
    await expect(c.crawl({ url: 'https://example.com/private/page' })).rejects.toThrow(/robots/);
  });

  it('returns notModified when server returns 304', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
      return new Response(null, { status: 304 });
    });
    const c = new Crawler({ fetchImpl });
    const r = await c.crawl({
      url: 'https://example.com/page',
      ifNoneMatch: '"abc"',
    });
    expect(r.notModified).toBe(true);
    expect(r.contentMarkdown).toBeUndefined();
  });

  it('rejects non-http(s) URLs', async () => {
    const c = new Crawler({ fetchImpl: fakeFetch(() => new Response('')) });
    await expect(c.crawl({ url: 'file:///etc/passwd' })).rejects.toThrow(/scheme/);
  });

  it('throws on HTTP error status', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    });
    const c = new Crawler({ fetchImpl });
    await expect(c.crawl({ url: 'https://example.com/page' })).rejects.toThrow(/HTTP 404/);
  });

  it('handles plain text responses', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
      return new Response('# Changelog\n\n## v1.2\n', {
        status: 200,
        headers: { 'content-type': 'text/markdown' },
      });
    });
    const c = new Crawler({ fetchImpl });
    const r = await c.crawl({ url: 'https://example.com/CHANGELOG.md' });
    expect(r.contentMarkdown).toContain('Changelog');
  });

  it('rate-limits per host', async () => {
    const calls: number[] = [];
    const fetchImpl = fakeFetch((url) => {
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
      calls.push(Date.now());
      return htmlResponse('<html><body><p>ok</p></body></html>');
    });
    const c = new Crawler({ fetchImpl });
    const t0 = Date.now();
    // 1 req/sec → second call should land ≥ ~1s after the first.
    await c.crawl({ url: 'https://example.com/a', rateLimitPerHost: 1 });
    await c.crawl({ url: 'https://example.com/b', rateLimitPerHost: 1 });
    const t1 = Date.now();
    expect(t1 - t0).toBeGreaterThanOrEqual(900);
  }, 5_000);
});

describe('BFS helpers', () => {
  it('extractLinks resolves relative + absolute URLs', () => {
    const html = `
      <a href="/docs/intro">Intro</a>
      <a href="https://example.com/about">About</a>
      <a href="hooks">Hooks (relative)</a>
      <a href="javascript:void(0)">JS link</a>
      <a href="mailto:hi@example.com">Email</a>
      <a href="#section">Anchor</a>
      <a href="ftp://files/x">FTP</a>
    `;
    const links = extractLinks('https://example.com/docs/v2/', html);
    expect(links).toContain('https://example.com/docs/intro');
    expect(links).toContain('https://example.com/about');
    expect(links).toContain('https://example.com/docs/v2/hooks');
    expect(links).not.toContain('javascript:void(0)');
    expect(links).not.toContain('mailto:hi@example.com');
    expect(links.find((l) => l.includes('#section'))).toBeUndefined();
    expect(links.find((l) => l.startsWith('ftp:'))).toBeUndefined();
  });

  it('parseSitemap pulls <loc> entries', () => {
    const xml = `<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/page1</loc></url>
        <url><loc>  https://example.com/page2  </loc></url>
        <url><loc>https://example.com/page3</loc></url>
      </urlset>`;
    expect(parseSitemap(xml)).toEqual([
      'https://example.com/page1',
      'https://example.com/page2',
      'https://example.com/page3',
    ]);
  });

  it('isAllowedHost matches subdomains by suffix', () => {
    const u1 = new URL('https://docs.example.com/x');
    const u2 = new URL('https://api.example.com/y');
    const u3 = new URL('https://other.org/z');
    expect(isAllowedHost(u1, ['example.com'])).toBe(true);
    expect(isAllowedHost(u2, ['example.com'])).toBe(true);
    expect(isAllowedHost(u3, ['example.com'])).toBe(false);
    // Empty allowlist = no restriction
    expect(isAllowedHost(u3, [])).toBe(true);
    expect(isAllowedHost(u3, undefined)).toBe(true);
  });

  it('canonicalize strips fragment + trailing slash', () => {
    expect(canonicalize('https://example.com/x#section')).toBe('https://example.com/x');
    expect(canonicalize('https://example.com/x/')).toBe('https://example.com/x');
    expect(canonicalize('https://example.com/')).toBe('https://example.com/');
  });

  it('subtreeBoundary computes parent path', () => {
    expect(subtreeBoundary(new URL('https://example.com/v2/intro'))).toBe('/v2/');
    expect(subtreeBoundary(new URL('https://example.com/v2/'))).toBe('/v2/');
    expect(subtreeBoundary(new URL('https://example.com/page'))).toBe('/');
  });
});

describe('Crawler.crawlMany', () => {
  function fakeFetch(handler: (url: string) => Response): typeof fetch {
    return ((input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : input.toString();
      return Promise.resolve(handler(u));
    }) as typeof fetch;
  }
  function htmlResponse(body: string): Response {
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  }

  it("scope:'page' yields exactly one result", async () => {
    const c = new Crawler({
      fetchImpl: fakeFetch((url) => {
        if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
        return htmlResponse('<html><body><main><p>only page</p></main></body></html>');
      }),
    });
    const results = [];
    for await (const r of c.crawlMany({ url: 'https://example.com/page', scope: 'page' })) {
      results.push(r);
    }
    expect(results).toHaveLength(1);
  });

  it("scope:'subtree' follows same-host links inside the parent path", async () => {
    const pages: Record<string, string> = {
      'https://example.com/docs/intro': `<html><body><main>
        <a href="/docs/hooks">Hooks</a>
        <a href="/docs/api">API</a>
        <a href="/blog/post1">Off-tree</a>
        <a href="https://other.org/x">Off-host</a>
      </main></body></html>`,
      'https://example.com/docs/hooks': '<html><body><main>hooks</main></body></html>',
      'https://example.com/docs/api': '<html><body><main>api</main></body></html>',
    };
    const c = new Crawler({
      fetchImpl: fakeFetch((url) => {
        if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
        const stripped = url.replace(/\/$/, '');
        return htmlResponse(pages[stripped] ?? '<html><body>404</body></html>');
      }),
    });
    const visited: string[] = [];
    for await (const r of c.crawlMany({
      url: 'https://example.com/docs/intro',
      scope: 'subtree',
      maxDepth: 2,
      rateLimitPerHost: 100, // fast for tests
    })) {
      visited.push(r.finalUrl);
    }
    expect(visited).toContain('https://example.com/docs/intro');
    expect(visited).toContain('https://example.com/docs/hooks');
    expect(visited).toContain('https://example.com/docs/api');
    // off-tree + off-host filtered out
    expect(visited.find((v) => v.includes('/blog/'))).toBeUndefined();
    expect(visited.find((v) => v.includes('other.org'))).toBeUndefined();
  });

  it("scope:'site' primes BFS from sitemap.xml when present", async () => {
    const sitemap = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://example.com/a</loc></url>
        <url><loc>https://example.com/b</loc></url>
        <url><loc>https://example.com/c</loc></url>
      </urlset>`;
    const visited: string[] = [];
    const c = new Crawler({
      fetchImpl: fakeFetch((url) => {
        if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
        if (url.endsWith('/sitemap.xml')) {
          return new Response(sitemap, {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          });
        }
        return htmlResponse(`<html><body><main>${url}</main></body></html>`);
      }),
    });
    for await (const r of c.crawlMany({
      url: 'https://example.com/',
      scope: 'site',
      maxDepth: 1,
      maxPages: 10,
      rateLimitPerHost: 100,
    })) {
      visited.push(r.finalUrl);
    }
    // start URL + 3 sitemap entries
    expect(visited.length).toBeGreaterThanOrEqual(3);
    expect(visited).toContain('https://example.com/a');
    expect(visited).toContain('https://example.com/b');
  });

  it('honors maxPages cap', async () => {
    const c = new Crawler({
      fetchImpl: fakeFetch((url) => {
        if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
        // Each page links to N more pages
        return htmlResponse(`<html><body><main>
          <a href="/p1">1</a><a href="/p2">2</a><a href="/p3">3</a><a href="/p4">4</a>
        </main></body></html>`);
      }),
    });
    let count = 0;
    for await (const _ of c.crawlMany({
      url: 'https://example.com/',
      scope: 'subtree',
      maxDepth: 5,
      maxPages: 3,
      rateLimitPerHost: 100,
    })) {
      count += 1;
    }
    expect(count).toBeLessThanOrEqual(3);
  });

  it('honors allowedDomains allowlist', async () => {
    const c = new Crawler({
      fetchImpl: fakeFetch((url) => {
        if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
        return htmlResponse('<html><body><main>x</main></body></html>');
      }),
    });
    // Same-host link that isn't in the allowlist would be excluded
    const visited: string[] = [];
    for await (const r of c.crawlMany({
      url: 'https://example.com/',
      scope: 'subtree',
      maxDepth: 2,
      allowedDomains: ['nope.com'],
      rateLimitPerHost: 100,
    })) {
      visited.push(r.finalUrl);
    }
    // Start URL is fetched (first page is unconditional); but no links
    // would match the allowlist so no further pages.
    expect(visited.length).toBeLessThanOrEqual(1);
  });
});

/**
 * URL crawler for ingestion (PRD F26 / CS-7d).
 *
 * v1 scope: `scope: 'page'` only — fetch one URL, run readability-style
 * extraction, hand off to loader-core's prose-markdown pipeline so the
 * graph nodes + events flow consistently with /v1/ingest/repo.
 *
 * Recursive scopes (subtree, site via sitemap.xml) are spec'd in the
 * PRD but not implemented here. They have meaningful design questions
 * (depth caps, allowlist semantics, what counts as a "site" vs the
 * page's parent path) that warrant their own slice.
 *
 * Defaults (per PRD CS9 lean):
 *   - robots.txt: strict — always honored.
 *   - Rate limit: 1 req/sec per host. Configurable per-call.
 *   - User-agent: edge-context-server/1.0 — identifies us in server logs.
 *
 * No external deps:
 *   - HTML extraction is a custom regex-based approach. Robust enough
 *     for tech-doc pages (Docusaurus/MkDocs/GitBook output); fragile
 *     on hand-rolled HTML. Upgrade to cheerio + Mozilla Readability
 *     when subtree/site scopes land.
 *   - robots.txt: subset of the spec — User-agent + Allow/Disallow +
 *     wildcard. Crawl-delay ignored (we use our own rate limit).
 */

const USER_AGENT = 'edge-context-server/1.0 (+https://github.com/anthropics)';

export type CrawlScope = 'page' | 'subtree' | 'site';

export interface CrawlRequest {
  url: string;
  /** Crawl breadth. Default 'page'.
   *   - 'page'    — fetch only the given URL.
   *   - 'subtree' — BFS following same-host links whose path starts with
   *                 the given URL's parent path (e.g., crawling
   *                 https://docs.foo.com/v2/ stays within /v2/...).
   *   - 'site'    — try sitemap.xml first; fall back to BFS with depth
   *                 cap across the whole host. */
  scope?: CrawlScope;
  /** Hop count cap for subtree/site BFS. Default 3. */
  maxDepth?: number;
  /** Total page cap (safety). Default 100. */
  maxPages?: number;
  /** Defense-in-depth allowlist — refuses to leave these hosts even
   *  if links / sitemap entries point elsewhere. Subdomain-suffix match
   *  ('docs.example.com' matches '*.example.com'). */
  allowedDomains?: string[];
  rateLimitPerHost?: number;
  respectRobotsTxt?: boolean;
  ifNoneMatch?: string;
  ifModifiedSince?: string;
}

export interface CrawlResult {
  url: string;
  finalUrl: string;
  status: number;
  notModified: boolean;
  contentType?: string;
  etag?: string;
  lastModified?: string;
  title?: string;
  contentMarkdown?: string;
  rawHtml?: string;
  contentHash?: string;
  fetchedAt: string;
}

export interface CrawlerOptions {
  fetchImpl?: typeof fetch;
}

class RateLimiter {
  private chains = new Map<string, Promise<void>>();

  async wait(host: string, rateLimitPerSec: number): Promise<void> {
    const minSpacingMs = Math.ceil(1000 / Math.max(rateLimitPerSec, 0.01));
    const prev = this.chains.get(host) ?? Promise.resolve();
    const next = prev.then(() => new Promise<void>((resolve) => setTimeout(resolve, minSpacingMs)));
    this.chains.set(host, next);
    await prev;
  }
}

export class Crawler {
  private readonly fetchImpl: typeof fetch;
  private readonly rateLimiter = new RateLimiter();
  private readonly robotsCache = new Map<string, { rules: RobotsRules; cachedAt: number }>();
  private static ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;

  constructor(opts: CrawlerOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async crawl(req: CrawlRequest): Promise<CrawlResult> {
    const url = new URL(req.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`unsupported URL scheme: ${url.protocol} (only http/https)`);
    }

    if (req.respectRobotsTxt !== false) {
      const allowed = await this.checkRobots(url);
      if (!allowed) {
        throw new Error(`robots.txt disallows fetching ${url.pathname} on ${url.host}`);
      }
    }

    await this.rateLimiter.wait(url.host, req.rateLimitPerHost ?? 1);

    const headers: Record<string, string> = { 'user-agent': USER_AGENT };
    if (req.ifNoneMatch) headers['if-none-match'] = req.ifNoneMatch;
    if (req.ifModifiedSince) headers['if-modified-since'] = req.ifModifiedSince;

    const response = await this.fetchImpl(url.toString(), { headers, redirect: 'follow' });
    const result: CrawlResult = {
      url: req.url,
      // Fall back to request URL when response.url is empty (test stubs
      // and some non-fetch implementations don't populate it).
      finalUrl: response.url || url.toString(),
      status: response.status,
      notModified: response.status === 304,
      contentType: response.headers.get('content-type') ?? undefined,
      etag: response.headers.get('etag') ?? undefined,
      lastModified: response.headers.get('last-modified') ?? undefined,
      fetchedAt: new Date().toISOString(),
    };

    if (result.notModified) return result;

    if (response.status >= 400) {
      throw new Error(`HTTP ${response.status} fetching ${req.url}`);
    }

    const ct = result.contentType ?? '';
    if (ct.includes('text/html') || ct.includes('application/xhtml')) {
      const html = await response.text();
      result.rawHtml = html;
      const extracted = extractReadable(html);
      result.title = extracted.title;
      result.contentMarkdown = extracted.markdown;
      result.contentHash = await sha256(extracted.markdown);
    } else if (ct.startsWith('text/') || ct.includes('json') || ct.includes('xml')) {
      const text = await response.text();
      result.contentMarkdown = text;
      result.contentHash = await sha256(text);
    } else {
      throw new Error(`unsupported content-type: ${ct} (only HTML/text in v1)`);
    }

    return result;
  }

  /**
   * Multi-page crawl. For 'page' scope, yields exactly one result.
   * For 'subtree' / 'site', BFS from the start URL with per-page
   * filtering: same-host required, path-prefix required for subtree,
   * allowedDomains enforced for both. Each page is fetched through the
   * same `crawl()` machinery, so robots.txt + rate-limit + readability
   * extraction apply uniformly. Aborts cleanly on signal.
   */
  async *crawlMany(req: CrawlRequest, signal?: AbortSignal): AsyncIterable<CrawlResult> {
    const scope = req.scope ?? 'page';
    if (scope === 'page') {
      yield await this.crawl(req);
      return;
    }

    const startUrl = new URL(req.url);
    const startHost = startUrl.host;
    const subtreePrefix = subtreeBoundary(startUrl);
    const maxDepth = req.maxDepth ?? 3;
    const maxPages = req.maxPages ?? 100;

    const visited = new Set<string>();
    const queue: Array<{ url: string; depth: number }> = [{ url: req.url, depth: 0 }];

    // For 'site' scope, prime the BFS queue with sitemap.xml entries
    // when available — much faster than crawling links and gets the
    // canonical set rather than navigation-noise.
    if (scope === 'site') {
      const sitemapUrls = await this.tryFetchSitemap(startUrl);
      for (const u of sitemapUrls) {
        try {
          const parsed = new URL(u);
          if (parsed.host !== startHost) continue;
          if (!isAllowedHost(parsed, req.allowedDomains)) continue;
          if (!visited.has(u)) queue.push({ url: u, depth: 1 });
        } catch {
          // skip malformed sitemap entries
        }
      }
    }

    let count = 0;
    while (queue.length > 0 && count < maxPages) {
      if (signal?.aborted) return;
      const next = queue.shift();
      if (!next) break;
      const { url, depth } = next;
      const canonical = canonicalize(url);
      if (visited.has(canonical)) continue;
      visited.add(canonical);

      let result: CrawlResult;
      try {
        result = await this.crawl({ ...req, url });
      } catch {
        // Per-page failures don't kill the crawl. Continue — caller
        // sees partial results and can retry. (Could emit an error
        // event upstream; consumers wrap with onEvent.)
        continue;
      }
      count += 1;
      yield result;

      if (depth >= maxDepth) continue;
      if (!result.rawHtml) continue;

      for (const link of extractLinks(result.finalUrl, result.rawHtml)) {
        const canonLink = canonicalize(link);
        if (visited.has(canonLink)) continue;
        let parsed: URL;
        try {
          parsed = new URL(link);
        } catch {
          continue;
        }
        if (parsed.host !== startHost) continue;
        if (!isAllowedHost(parsed, req.allowedDomains)) continue;
        if (scope === 'subtree' && !parsed.pathname.startsWith(subtreePrefix)) continue;
        queue.push({ url: link, depth: depth + 1 });
      }
    }
  }

  /**
   * Best-effort sitemap.xml fetcher. Tries /sitemap.xml at the host
   * root; returns parsed URL list or [] if missing/malformed.
   */
  private async tryFetchSitemap(startUrl: URL): Promise<string[]> {
    const sitemapUrl = `${startUrl.protocol}//${startUrl.host}/sitemap.xml`;
    try {
      const r = await this.fetchImpl(sitemapUrl, { headers: { 'user-agent': USER_AGENT } });
      if (r.status < 200 || r.status >= 300) return [];
      const xml = await r.text();
      return parseSitemap(xml);
    } catch {
      return [];
    }
  }

  private async checkRobots(url: URL): Promise<boolean> {
    const robotsUrl = `${url.protocol}//${url.host}/robots.txt`;
    const cached = this.robotsCache.get(url.host);
    let rules: RobotsRules;
    if (cached && Date.now() - cached.cachedAt < Crawler.ROBOTS_TTL_MS) {
      rules = cached.rules;
    } else {
      try {
        const r = await this.fetchImpl(robotsUrl, { headers: { 'user-agent': USER_AGENT } });
        if (r.status >= 200 && r.status < 300) {
          rules = parseRobotsTxt(await r.text());
        } else {
          rules = { userAgents: { '*': { allow: [], disallow: [] } } };
        }
      } catch {
        rules = { userAgents: { '*': { allow: [], disallow: [] } } };
      }
      this.robotsCache.set(url.host, { rules, cachedAt: Date.now() });
    }
    return isAllowed(rules, USER_AGENT, url.pathname);
  }
}

// ─── readability extraction ─────────────────────────────────────────

function extractReadable(html: string): { title?: string; markdown: string } {
  // Title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]?.trim() ?? '') : undefined;

  // Strip nuke-list elements completely.
  let body = html;
  for (const tag of ['script', 'style', 'noscript', 'iframe', 'nav', 'footer', 'aside', 'header']) {
    body = body.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  }

  // Pick the densest content region: <main>, <article>, then full body.
  const mainMatch = body.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const articleMatch = body.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const bodyMatch = body.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const region = mainMatch?.[1] ?? articleMatch?.[1] ?? bodyMatch?.[1] ?? body;

  // Convert headings to markdown.
  let md = region;
  md = md.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_, c) => `\n\n# ${stripTags(c)}\n\n`);
  md = md.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_, c) => `\n\n## ${stripTags(c)}\n\n`);
  md = md.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (_, c) => `\n\n### ${stripTags(c)}\n\n`);
  md = md.replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, (_, c) => `\n\n#### ${stripTags(c)}\n\n`);
  md = md.replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, (_, c) => `\n\n##### ${stripTags(c)}\n\n`);
  md = md.replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, (_, c) => `\n\n###### ${stripTags(c)}\n\n`);
  md = md.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => `\n\n\`\`\`\n${stripTags(c)}\n\`\`\`\n\n`);
  md = md.replace(/<\/(p|li|tr)>/gi, '\n');
  md = stripTags(md);
  md = decodeEntities(md);
  md = md.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  return { title, markdown: md };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

async function sha256(s: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(s).digest('hex');
}

// ─── robots.txt parsing ─────────────────────────────────────────────

interface RobotsRules {
  userAgents: Record<string, { allow: string[]; disallow: string[] }>;
}

function parseRobotsTxt(text: string): RobotsRules {
  const rules: RobotsRules = { userAgents: {} };
  const lines = text.split(/\r?\n/);
  let currentAgents: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) {
      currentAgents = [];
      continue;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const directive = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (directive === 'user-agent') {
      currentAgents.push(value.toLowerCase());
      if (!rules.userAgents[value.toLowerCase()]) {
        rules.userAgents[value.toLowerCase()] = { allow: [], disallow: [] };
      }
    } else if (directive === 'allow' || directive === 'disallow') {
      if (currentAgents.length === 0) continue;
      for (const ua of currentAgents) {
        const bucket = rules.userAgents[ua];
        if (!bucket) continue;
        bucket[directive].push(value);
      }
    }
  }
  return rules;
}

function isAllowed(rules: RobotsRules, ua: string, path: string): boolean {
  const uaLower = ua.toLowerCase();
  let bucket = rules.userAgents['*'];
  for (const [agent, b] of Object.entries(rules.userAgents)) {
    if (agent !== '*' && uaLower.includes(agent)) {
      bucket = b;
      break;
    }
  }
  if (!bucket) return true;

  let best: { rule: string; allow: boolean } | null = null;
  for (const d of bucket.disallow) {
    if (d === '') continue;
    if (matchesRobotsPattern(path, d)) {
      if (!best || d.length > best.rule.length) best = { rule: d, allow: false };
    }
  }
  for (const a of bucket.allow) {
    if (a === '') continue;
    if (matchesRobotsPattern(path, a)) {
      if (!best || a.length > best.rule.length) best = { rule: a, allow: true };
    }
  }
  return best?.allow ?? true;
}

function matchesRobotsPattern(path: string, pattern: string): boolean {
  let regexStr = '^';
  for (const ch of pattern) {
    if (ch === '*') regexStr += '.*';
    else if (ch === '$') regexStr += '$';
    else regexStr += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(regexStr).test(path);
}

// ─── BFS helpers ─────────────────────────────────────────────────────

/** Strip fragment + trailing slash from a URL for dedup. */
function canonicalize(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

/** Path prefix that defines a "subtree" boundary for a starting URL.
 *  e.g., https://docs.foo.com/v2/intro → /v2/  (drops trailing filename). */
function subtreeBoundary(start: URL): string {
  const path = start.pathname;
  if (path.endsWith('/')) return path;
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '/';
}

/** Suffix-match host against an allowlist. 'example.com' matches
 *  'docs.example.com', 'api.example.com', etc. Empty/undefined
 *  allowlist means "no restriction beyond same-host". */
function isAllowedHost(url: URL, allowedDomains: string[] | undefined): boolean {
  if (!allowedDomains || allowedDomains.length === 0) return true;
  const host = url.host.toLowerCase();
  for (const d of allowedDomains) {
    const dl = d.toLowerCase();
    if (host === dl || host.endsWith(`.${dl}`)) return true;
  }
  return false;
}

/** Extract <a href="..."> URLs from raw HTML. Resolves relative paths
 *  against the page's final URL. Skips javascript:/mailto:/tel: links
 *  and anchor-only fragments. Deduplicates. */
function extractLinks(baseUrl: string, html: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return out;
  }
  const matches = html.matchAll(/<a\s+(?:[^>]*?\s+)?href=["']([^"']+)["']/gi);
  for (const m of matches) {
    const raw = m[1];
    if (!raw) continue;
    const lc = raw.toLowerCase().trim();
    if (lc.startsWith('javascript:') || lc.startsWith('mailto:') || lc.startsWith('tel:')) continue;
    if (lc.startsWith('#')) continue;
    try {
      const u = new URL(raw, base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      u.hash = '';
      const canonical = u.toString();
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      out.push(canonical);
    } catch {
      // bad URL — skip
    }
  }
  return out;
}

/** Minimal sitemap.xml parser. Handles <urlset> (page list) + nested
 *  <sitemap><loc>…</loc></sitemap> (sitemap index — we extract child
 *  sitemap URLs but DON'T recurse into them in v1; that's a follow-up).
 *  Plain <loc>…</loc> regex extraction is sufficient for v1; full XML
 *  parsing would add a dep without meaningful gain. */
function parseSitemap(xml: string): string[] {
  const out: string[] = [];
  const matches = xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi);
  for (const m of matches) {
    const url = m[1]?.trim();
    if (url) out.push(url);
  }
  return out;
}

export const __test__ = {
  extractReadable,
  parseRobotsTxt,
  isAllowed,
  extractLinks,
  parseSitemap,
  isAllowedHost,
  canonicalize,
  subtreeBoundary,
};

/**
 * Deterministic semantic-domain classifier for ingested files (Tier 2).
 *
 * Tags each node with a coarse `domain` (security, testing, api, …) derived
 * from its path + source type — NO LLM. This is the lightweight half of the
 * domain model: a queryable property workers can filter on. The heavier
 * options from the gap analysis (an LLM classifier + per-domain vector
 * indexes / collections) are deliberately deferred; path heuristics cover
 * the common cases at zero cost and stay fully deterministic + testable.
 *
 * Domains are best-effort tags, not ground truth — `code` is the catch-all
 * for source that matches no stronger signal, `other` for non-code sources
 * that match nothing.
 */

export const DOMAINS = [
  'testing',
  'security',
  'api',
  'data',
  'ui',
  'config',
  'build',
  'infra',
  'docs',
  'code',
  'other',
] as const;

export type Domain = (typeof DOMAINS)[number];

/** Ordered path/filename rules — FIRST match wins, so order encodes priority
 *  (e.g. a `*.test.tsx` is `testing`, not `ui`; an `auth/` file under
 *  `infra/` is `infra`). */
const RULES: Array<{ domain: Domain; test: RegExp }> = [
  {
    domain: 'testing',
    test: /(^|\/)(tests?|specs?|__tests__|__mocks__|e2e|fixtures?)(\/|$)|\.(test|spec)\.[a-z]+$/i,
  },
  {
    domain: 'infra',
    test: /(^|\/)(terraform|infra|deploy(ment)?|k8s|kubernetes|helm|ansible|\.github|\.circleci)(\/|$)|\.tf$|dockerfile/i,
  },
  {
    domain: 'security',
    test: /(^|\/)(auth[nz]?|security|crypto|oauth|oidc|login|session|permissions?|rbac|acl|secrets?)(\/|$|\.)/i,
  },
  {
    domain: 'config',
    test: /(^|\/)config(\/|$)|(^|\/)(package\.json|tsconfig[^/]*\.json|[^/]*\.config\.[a-z]+|[^/]*\.ya?ml|[^/]*\.toml|[^/]*\.ini|\.env[^/]*)$/i,
  },
  {
    domain: 'build',
    test: /(^|\/)(scripts?|build|tooling|ci)(\/|$)|(^|\/)(makefile|justfile|gulpfile|webpack[^/]*|vite\.config[^/]*|rollup[^/]*)$/i,
  },
  {
    domain: 'data',
    test: /(^|\/)(models?|schemas?|migrations?|db|database|entit(y|ies)|repositor(y|ies)|dao|sql)(\/|$)/i,
  },
  {
    domain: 'api',
    test: /(^|\/)(api|routes?|controllers?|handlers?|endpoints?|graphql|rest|rpc|grpc)(\/|$)/i,
  },
  {
    domain: 'ui',
    test: /(^|\/)(components?|ui|views?|pages?|widgets?|screens?|styles?)(\/|$)|\.(tsx|jsx|vue|svelte|css|scss)$/i,
  },
  {
    domain: 'docs',
    test: /(^|\/)(docs?|documentation)(\/|$)|(^|\/)readme|\.mdx?$/i,
  },
];

/** Fallback when no path rule matches — keyed by source type. */
const SOURCE_TYPE_DEFAULT: Record<string, Domain> = {
  'code-full': 'code',
  'oss-code': 'code',
  'prose-markdown': 'docs',
  'oss-docs': 'docs',
  'crawled-web': 'docs',
  pdf: 'docs',
  'image-described': 'docs',
  config: 'config',
  'structured-schema': 'data',
};

/** Classify a file into a coarse semantic domain. Pure + deterministic. */
export function classifyDomain(relativePath: string, sourceTypeId: string): Domain {
  const p = relativePath.replace(/\\/g, '/');
  for (const rule of RULES) {
    if (rule.test.test(p)) return rule.domain;
  }
  return SOURCE_TYPE_DEFAULT[sourceTypeId] ?? 'other';
}

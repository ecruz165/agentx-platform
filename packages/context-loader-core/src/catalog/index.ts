/**
 * BUILTIN_SOURCE_TYPES — the 13-entry v1 catalog.
 *
 * Phase A: only matchers + graph schema declared. Chunker behaviors and
 * source-type-specific logic land in Phase B-E per
 * .plans/2026-05-05-prd-context-loader-core.md §11.
 *
 * This file is the source of truth for what the loader can ingest by default.
 * Per-workspace extensions (via .harness/config/context-sources.yml) merge
 * into this catalog at runtime.
 */

import type { SourceType, SourceTypeId } from '../types.ts';

/* eslint-disable @typescript-eslint/no-unused-vars -- chunker placeholders fleshed out in Phase B */

const codeFull: SourceType = {
  id: 'code-full',
  description:
    'Own-code repos — function/class-level chunks via tree-sitter AST; both skeleton and body chunks linked by SkeletonOf edge.',
  matcher: {
    include: ['**/*.{ts,tsx,js,jsx,java,kt,py,go,rs,c,cpp,h,hpp}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/.gradle/**',
      '**/target/**',
      '**/venv/**',
      '**/__pycache__/**',
    ],
    maxFileBytes: 262144,
  },
  graphSchema: {
    nodes: ['File', 'Function', 'Class', 'Module'],
    edges: ['Imports', 'Calls', 'Extends', 'Implements', 'SkeletonOf'],
  },
  chunker: {
    type: 'tree-sitter',
    granularity: 'function-class',
    skeletonExtraction: true,
    bodyExtraction: true,
    grammars: ['typescript', 'javascript', 'java', 'kotlin', 'python', 'go', 'rust', 'c', 'cpp'],
  },
};

const ossCode: SourceType = {
  id: 'oss-code',
  description:
    'OSS dependency code — skeleton-only by default for ~10× volume reduction; bodies extracted only for examples/READMEs.',
  matcher: {
    include: ['**/*.{ts,tsx,js,jsx,java,kt,py,go,rs,c,cpp,h,hpp}'],
    exclude: ['**/tests/**', '**/__tests__/**', '**/spec/**', '**/test/**'],
    maxFileBytes: 262144,
  },
  graphSchema: {
    nodes: ['Package', 'Version', 'OssFile', 'OssFunction', 'OssClass', 'OssExport'],
    // 'Contains' is the structural File→Function/Class edge (same as
    // code-full). 'BelongsTo' carries provenance: OssFile → Version,
    // Version → Package. 'Exports' / 'ImportedBy' come online with
    // Phase C.7 cross-source-type edges.
    edges: ['Contains', 'BelongsTo', 'Exports', 'ImportedBy'],
  },
  // Read package.json at the source root → emit Package + Version +
  // BelongsTo edges (Phase C.4).
  provenance: 'oss-package',
  chunker: {
    type: 'tree-sitter',
    granularity: 'function-class',
    skeletonExtraction: true,
    bodyExtraction: false,
    bodyExceptions: ['**/examples/**', '**/README*'],
    // Emit OssFile/OssFunction/OssClass to match the declared graphSchema.
    // First-party code-full keeps the canonical File/Function/Class
    // (no labelPrefix → '' → unmodified).
    labelPrefix: 'Oss',
    grammars: ['typescript', 'javascript', 'java', 'kotlin', 'python', 'go', 'rust', 'c', 'cpp'],
  },
};

const proseMarkdown: SourceType = {
  id: 'prose-markdown',
  description: 'Local markdown docs — heading-based chunking; extracts links as LinkedFrom edges.',
  matcher: {
    include: ['**/*.{md,mdx,rst,txt}', '**/README*'],
    // Skip dependency / build / VCS trees by default — users rarely want
    // 50K READMEs from node_modules ingested as their own prose.
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/target/**',
      '**/venv/**',
      '**/__pycache__/**',
    ],
  },
  graphSchema: {
    nodes: ['Doc', 'Section'],
    edges: ['Mentions', 'LinkedFrom'],
  },
  chunker: {
    type: 'heading-based',
    maxTokens: 2048,
    overlapTokens: 128,
  },
};

const crawledWeb: SourceType = {
  id: 'crawled-web',
  description:
    'Web docs — Mozilla Readability extraction → markdown → heading-based chunker. Detects Docusaurus/MkDocs/Starlight for better section extraction.',
  matcher: {}, // URL-driven, not file-pattern; matcher unused
  graphSchema: {
    nodes: ['Doc'],
    edges: ['Mentions'],
  },
  chunker: {
    type: 'crawler',
    scope: 'subtree',
    maxDepth: 3,
    rateLimitPerHost: 1,
  },
};

const ossDocs: SourceType = {
  id: 'oss-docs',
  description:
    'OSS dependency docs — path-based v1: ingests **/*.{md,mdx,rst} from a docs/ directory beside package.json. Web crawl + code-example extraction land in a later slice (when crawler chunker exists).',
  matcher: {
    include: ['**/*.{md,mdx,rst,txt}', '**/README*'],
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/target/**',
      '**/venv/**',
    ],
  },
  graphSchema: {
    // OssDoc + OssSection match the heading-based chunker's emitted
    // labels under labelPrefix='Oss'. OssDocCodeExample lands when
    // code-fence extraction is implemented (still a Phase D concern).
    nodes: ['OssDoc', 'OssSection'],
    // 'Contains' (Doc → Section) and 'LinkedFrom' (markdown links)
    // come from heading-based. 'BelongsTo' is the OSS provenance link.
    // 'Documents' lands with Phase C.7 cross-source-type edges.
    edges: ['Contains', 'LinkedFrom', 'BelongsTo', 'Documents'],
    crossTypeEdges: [
      { edge: 'Documents', targetSourceTypeId: 'oss-code', targetNodeLabel: 'OssFunction' },
      { edge: 'Documents', targetSourceTypeId: 'oss-code', targetNodeLabel: 'OssClass' },
    ],
  },
  // v1: path-based. Web crawler comes online when 'crawler' chunker
  // is implemented (Phase D); same labelPrefix lets the URL-driven
  // path emit the same OssDoc/OssSection schema.
  provenance: 'oss-package',
  chunker: {
    type: 'heading-based',
    maxTokens: 2048,
    overlapTokens: 128,
    labelPrefix: 'Oss',
  },
};

const ossIssues: SourceType = {
  id: 'oss-issues',
  description:
    'OSS dependency issues from GitHub/GitLab API — heavy curation: closed-with-fix only; symbol-mention extraction emits Mentions edges to OssFunction.',
  matcher: {}, // API-driven
  graphSchema: {
    nodes: ['OssIssue', 'OssComment', 'OssPullRequest'],
    edges: ['RelatedTo', 'FixedIn', 'Mentions'],
    crossTypeEdges: [
      { edge: 'Mentions', targetSourceTypeId: 'oss-code', targetNodeLabel: 'OssFunction' },
      { edge: 'FixedIn', targetSourceTypeId: 'oss-code', targetNodeLabel: 'Version' },
    ],
  },
  chunker: { type: 'issue-thread', issueBodyMinChars: 100, commentMinChars: 50 },
};

const structuredSchema: SourceType = {
  id: 'structured-schema',
  description:
    'OpenAPI/GraphQL/SQL/Proto schemas — per-endpoint or per-type chunks; preserves schema relationships as graph edges.',
  matcher: {
    include: [
      '**/*.openapi.{json,yaml,yml}',
      '**/openapi.{json,yaml,yml}',
      '**/swagger.{json,yaml,yml}',
      '**/*.graphql',
      '**/schema.sql',
      '**/*.proto',
    ],
  },
  graphSchema: {
    nodes: ['Schema', 'Endpoint', 'Type'],
    edges: ['References', 'Returns', 'Accepts'],
  },
  chunker: { type: 'whole-file' },
};

const configType: SourceType = {
  id: 'config',
  description: 'Small project configs (tsconfig, pyproject, etc.) — whole-file chunks for files <16 KB.',
  matcher: {
    include: ['**/{tsconfig,jsconfig,pyproject,Cargo,package,go,gradle,babel,eslint,prettier,vite,vitest,webpack,rollup,esbuild}.{json,toml,yaml,yml,ts,js}'],
    maxFileBytes: 16384,
  },
  graphSchema: {
    nodes: ['Config'],
    edges: [],
  },
  chunker: { type: 'whole-file' },
};

const issueTracker: SourceType = {
  id: 'issue-tracker',
  description: 'Internal Jira/Confluence/etc. — same chunking as oss-issues but provider-aware via CredentialBroker.',
  matcher: {}, // API-driven
  graphSchema: {
    nodes: ['Issue', 'Comment'],
    edges: ['RelatedTo', 'AssignedTo'],
  },
  chunker: { type: 'issue-thread', issueBodyMinChars: 100, commentMinChars: 50 },
};

const imageDescribed: SourceType = {
  id: 'image-described',
  description:
    'Images — two-stage: vision LLM describes → text embedder vectorizes. Uses agent-vl Docker service; calls @agentx/agent-adapter directly (NOT through harness-core).',
  matcher: {
    include: ['**/*.{png,jpg,jpeg,webp,gif}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**'],
  },
  graphSchema: {
    nodes: ['Image', 'Description'],
    edges: ['AppearsIn', 'ScreenshotOf'],
  },
  chunker: { type: 'image-vision' },
};

const pdf: SourceType = {
  id: 'pdf',
  description: 'PDFs — per-page text extraction; for scanned PDFs, falls back to per-page vision-LLM description.',
  matcher: {
    include: ['**/*.pdf'],
  },
  graphSchema: {
    nodes: ['Doc'],
    edges: ['Mentions'],
  },
  chunker: { type: 'pdf-page', visionFallback: true },
};

const learned: SourceType = {
  id: 'learned',
  description:
    'End-of-job memory promotions — different lifecycle: written by harness-server\'s evaluator phase, not by user-triggered ingestion.',
  matcher: {}, // not file-driven; programmatic only
  graphSchema: {
    nodes: ['Learning'],
    edges: ['DerivedFrom', 'RelatedTo'],
  },
  chunker: { type: 'whole-file' },
};

const skip: SourceType = {
  id: 'skip',
  description:
    'Explicit denylist — files matching this type produce zero chunks. Documents what should never be ingested under any other type.',
  matcher: {
    include: [
      '**/*.{exe,dll,so,dylib}',
      '**/*.{zip,tar,gz,7z,rar}',
      '**/*.{pyc,class,o,obj}',
      '**/*.{otf,ttf,woff,woff2,eot}',
      '**/*.{psd,bmpr,ai,sketch,fig}',
      '**/package-lock.json',
      '**/yarn.lock',
      '**/pnpm-lock.yaml',
      '**/Cargo.lock',
      '**/poetry.lock',
      '**/go.sum',
      '**/.terraform/providers/**',
    ],
  },
  graphSchema: { nodes: [], edges: [] },
  chunker: { type: 'whole-file' }, // never invoked since produces zero chunks
};

/**
 * The v1 catalog. Order matters: matchers are evaluated first-match-wins
 * when a file could match multiple types. `skip` is intentionally LAST as
 * a documentation aid — its patterns also appear in other types' excludes.
 */
export const BUILTIN_SOURCE_TYPES: Record<SourceTypeId, SourceType> = {
  'code-full': codeFull,
  'oss-code': ossCode,
  'prose-markdown': proseMarkdown,
  'crawled-web': crawledWeb,
  'oss-docs': ossDocs,
  'oss-issues': ossIssues,
  'structured-schema': structuredSchema,
  config: configType,
  'issue-tracker': issueTracker,
  'image-described': imageDescribed,
  pdf,
  learned,
  skip,
};

/** Convenience accessor; throws if id is unknown (and not user-extended). */
export function getBuiltinSourceType(id: SourceTypeId): SourceType {
  return BUILTIN_SOURCE_TYPES[id];
}

/** All built-in ids in catalog order. */
export const BUILTIN_SOURCE_TYPE_IDS: SourceTypeId[] = Object.keys(
  BUILTIN_SOURCE_TYPES
) as SourceTypeId[];

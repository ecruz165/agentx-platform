/**
 * Tree-sitter-based chunker for the `code-full` source type.
 *
 * Produces function/class/method-level chunks suitable for embedding,
 * plus a `File` node + `Contains` edges into the per-symbol nodes.
 *
 * Phase B.2 scope: TypeScript / TSX / JavaScript / Python. Other catalog
 * languages (Java, Kotlin, Go, Rust, C, C++) ride along — the grammar
 * package ships them prebuilt; we just need extension dispatch.
 *
 * Phase D will introduce skeleton-vs-body chunk separation + SkeletonOf
 * edges; that's the lever `oss-code` uses to ingest 10× less volume.
 * For B.2 we emit one chunk per symbol with the full declaration text;
 * dropping in skeleton extraction later is additive (more nodes/chunks,
 * same Function nodes).
 *
 * Runtime model:
 *   - One Parser instance, lazily initialized on first use
 *   - One Language object per grammar, lazily loaded on demand
 *   - Both cached at module scope; cheap to call chunkCodeFull() many
 *     times in one ingest run
 *
 * Why web-tree-sitter (WASM) instead of native tree-sitter:
 *   - Zero build-toolchain requirement on consumers' machines
 *   - Same code path on Bun (CLI) and Node (edge-context-server)
 *   - Grammars come prebuilt via @vscode/tree-sitter-wasm — no tree-
 *     sitter-cli + emscripten install dance
 *   - Per-platform native ABI breakage from prior native dependencies doesn't apply
 *
 * The cost is ~30% slower than native parsing. For one-time ingestion
 * runs at code-full's scale (tens of thousands of files), wall-clock
 * is dominated by embedding HTTP latency, not parser throughput.
 */

import { extname, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { Parser, Language, type Node as TSNode } from 'web-tree-sitter';
import type { GraphEdge, GraphNode } from '../../types.ts';

// ─── Public types ──────────────────────────────────────────────────────────

export interface CodeFullChunkInput {
  /** Repo-relative path used as the File node id and the prefix for symbol ids. */
  relativePath: string;
  /** The source contents. */
  content: string;
  /** Source type id (e.g., 'code-full'); copied through onto every emitted node/edge. */
  sourceTypeId: string;
  /** Logical source id (e.g., 'workspace-skoolscout-com'); copied through. */
  sourceId: string;
  /** Optional license tag for OSS sources. */
  license?: string;
  /**
   * Chunk extraction mode.
   *
   * - `'full'` (default) — chunk text is the entire declaration (signature
   *   + body). Used for first-party code where queries often want to see
   *   how something is implemented.
   * - `'skeleton-only'` — chunk text is just the signature (declaration
   *   start through, but not including, the body block). Used for OSS
   *   dependencies where the volume reduction (~10×) lets us index much
   *   larger surfaces while preserving usage-pattern discoverability.
   */
  mode?: 'full' | 'skeleton-only';
  /**
   * Optional prefix prepended to every emitted node label. oss-code uses
   * 'Oss' to produce OssFile / OssFunction / OssClass and align with its
   * declared graphSchema. Default: '' — first-party code keeps the
   * canonical File / Function / Class labels.
   *
   * Affects chunker-emitted *node* labels only; edge labels stay as
   * declared on the schema (Contains, etc.). Cross-source-type relabeling
   * of edges (e.g., Contains → BelongsTo for oss-code) is a separate
   * concern that lands when Package / Version provenance arrives.
   */
  labelPrefix?: string;
}

export interface CodeFullChunkOutput {
  nodes: GraphNode[];
  edges: GraphEdge[];
  chunks: Array<{ nodeId: string; text: string }>;
}

// ─── Grammar registry ──────────────────────────────────────────────────────

/** Map file extension → grammar key in @vscode/tree-sitter-wasm. */
const EXT_TO_GRAMMAR: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
};

/** Per-grammar AST node types we treat as "extractable symbol declarations". */
const DECLARATION_NODE_TYPES: Record<string, ReadonlySet<string>> = {
  typescript: new Set([
    'function_declaration',
    'class_declaration',
    'method_definition',
    'interface_declaration',
    'enum_declaration',
    'type_alias_declaration',
  ]),
  tsx: new Set([
    'function_declaration',
    'class_declaration',
    'method_definition',
    'interface_declaration',
    'enum_declaration',
    'type_alias_declaration',
  ]),
  javascript: new Set([
    'function_declaration',
    'class_declaration',
    'method_definition',
  ]),
  python: new Set([
    'function_definition',
    'class_definition',
  ]),
};

/** Map AST node type → graph node label for our schema. */
const NODE_TYPE_TO_LABEL: Record<string, string> = {
  function_declaration: 'Function',
  function_definition: 'Function',
  class_declaration: 'Class',
  class_definition: 'Class',
  method_definition: 'Function', // we treat methods as Function in v1; class context is on the edge
  interface_declaration: 'Class', // close enough for v1; refine when query patterns diverge
  enum_declaration: 'Class',
  type_alias_declaration: 'Class',
};

// ─── Lazy initialization ───────────────────────────────────────────────────

let parserInitPromise: Promise<void> | null = null;
const languageCache = new Map<string, Language>();
const require_ = createRequire(import.meta.url);

/** One-time Parser.init(). Two wasm sources:
 *    - The web-tree-sitter *runtime* (`web-tree-sitter.wasm`) ships inside
 *      the web-tree-sitter package itself.
 *    - The grammar wasms (`tree-sitter-typescript.wasm`, etc.) ship inside
 *      @vscode/tree-sitter-wasm.
 *  We resolve them via require.resolve() so the paths are correct under
 *  pnpm's nested node_modules layout, npm's flat layout, or yarn pnp. */
async function ensureParserInit(): Promise<void> {
  if (parserInitPromise) return parserInitPromise;
  parserInitPromise = (async () => {
    // The web-tree-sitter package explicitly exports the wasm subpath.
    // Resolving it gives us the absolute path; its parent is the runtime dir.
    const runtimeWasmPath = require_.resolve('web-tree-sitter/web-tree-sitter.wasm');
    const runtimeDir = dirname(runtimeWasmPath);
    await Parser.init({
      // Runtime asks for `web-tree-sitter.wasm` by name; we point it at
      // the bundled location.
      locateFile: (file: string) => `${runtimeDir}/${file}`,
    });
  })();
  return parserInitPromise;
}

async function getLanguage(grammarKey: string): Promise<Language> {
  const cached = languageCache.get(grammarKey);
  if (cached) return cached;
  await ensureParserInit();
  // @vscode/tree-sitter-wasm doesn't restrict subpath access via `exports`,
  // so we can resolve the .wasm directly without going through package.json.
  const wasmPath = require_.resolve(
    `@vscode/tree-sitter-wasm/wasm/tree-sitter-${grammarKey}.wasm`
  );
  const lang = await Language.load(wasmPath);
  languageCache.set(grammarKey, lang);
  return lang;
}

// ─── Grammar dispatch ──────────────────────────────────────────────────────

/** Pick a grammar key from a relative path's extension; returns null if
 *  the file extension isn't one we have a grammar for (caller should
 *  skip the file). */
export function pickGrammar(relativePath: string): string | null {
  const ext = extname(relativePath).toLowerCase();
  return EXT_TO_GRAMMAR[ext] ?? null;
}

// ─── Main entry point ──────────────────────────────────────────────────────

export async function chunkCodeFull(
  input: CodeFullChunkInput
): Promise<CodeFullChunkOutput> {
  const grammarKey = pickGrammar(input.relativePath);
  if (!grammarKey) {
    return { nodes: [], edges: [], chunks: [] };
  }
  const lang = await getLanguage(grammarKey);
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(input.content);
  if (!tree) {
    throw new Error(`tree-sitter parse returned null for ${input.relativePath}`);
  }

  const decls = DECLARATION_NODE_TYPES[grammarKey];
  if (!decls) {
    throw new Error(`internal: no declaration set registered for grammar '${grammarKey}'`);
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const chunks: Array<{ nodeId: string; text: string }> = [];

  const labelPrefix = input.labelPrefix ?? '';

  // File node — every code-full ingest emits one per file as the parent.
  const fileId = input.relativePath;
  nodes.push({
    id: fileId,
    label: `${labelPrefix}File`,
    properties: {
      path: input.relativePath,
      grammar: grammarKey,
      lineCount: input.content.split('\n').length,
    },
    sourceTypeId: input.sourceTypeId,
    sourceId: input.sourceId,
    license: input.license,
  });

  // Walk the AST. We use a stack-based iterative walk because tree-sitter
  // ASTs for large files can be deep, and we want to emit declarations in
  // source order without recursion-depth concerns.
  const stack: TSNode[] = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (decls.has(node.type)) {
      const symbol = extractDeclaration(node, input, fileId, grammarKey);
      if (symbol) {
        nodes.push(symbol.node);
        edges.push(symbol.containsEdge);
        chunks.push(symbol.chunk);
      }
      // Don't descend into the body — we treat the whole declaration as
      // one chunk in v1. Phase D will descend into class bodies to emit
      // method-level skeleton/body chunks separately.
      continue;
    }
    // Push children in reverse so we pop them left-to-right.
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push(child);
    }
  }

  tree.delete();
  parser.delete();

  return { nodes, edges, chunks };
}

// ─── Declaration extraction ────────────────────────────────────────────────

function extractDeclaration(
  node: TSNode,
  input: CodeFullChunkInput,
  fileId: string,
  grammarKey: string
): { node: GraphNode; containsEdge: GraphEdge; chunk: { nodeId: string; text: string } } | null {
  const name = symbolName(node);
  if (!name) return null;

  // If the declaration sits inside an `export_statement` (TS/JS), we widen
  // the chunk start to include the `export` keyword. For skeleton-only
  // mode this is the lever that makes "which functions does this package
  // export?" answerable from the chunk text alone — without it, every
  // signature loses its public/private signal.
  const exportNode =
    node.parent?.type === 'export_statement' ? node.parent : null;
  const declStart = exportNode ? exportNode.startIndex : node.startIndex;
  const startLine =
    (exportNode ? exportNode.startPosition.row : node.startPosition.row) + 1;
  const endLine = node.endPosition.row + 1;
  const fullText = input.content.slice(declStart, node.endIndex);

  // Skeleton-only mode: chunk text is the signature, not the body. We slice
  // from the declaration start up to (but not including) the body block.
  // Tree-sitter exposes the body as the 'body' field on declaration nodes
  // for both TS and Python. If a declaration has no body field (a rare
  // shape — e.g., interface_declaration with only signatures), the
  // skeleton equals the full declaration anyway.
  const mode = input.mode ?? 'full';
  let chunkText = fullText;
  if (mode === 'skeleton-only') {
    const bodyNode = node.childForFieldName('body');
    if (bodyNode) {
      chunkText = input.content.slice(declStart, bodyNode.startIndex).trimEnd();
    }
  }

  // Symbol id: relativePath#name:startLine. Line number disambiguates the
  // (rare) case of identically-named declarations in the same file.
  const symbolId = `${fileId}#${name}:${startLine}`;
  const baseLabel = NODE_TYPE_TO_LABEL[node.type] ?? 'Function';
  const labelPrefix = input.labelPrefix ?? '';
  const label = `${labelPrefix}${baseLabel}`;

  const graphNode: GraphNode = {
    id: symbolId,
    label,
    properties: {
      name,
      kind: node.type,
      grammar: grammarKey,
      startLine,
      endLine,
      lineCount: endLine - startLine + 1,
      // charCount reflects the indexed (chunk) text — useful when comparing
      // skeleton vs body footprints. fullCharCount preserves the original.
      charCount: chunkText.length,
      fullCharCount: fullText.length,
      mode,
      // Chunk text on the node — same purpose as in heading-based (used
      // by Phase C.7's Documents-edge linker + query-result payloads).
      // For skeleton-only mode this is just the signature; for full mode
      // it's the whole declaration.
      text: chunkText,
    },
    sourceTypeId: input.sourceTypeId,
    sourceId: input.sourceId,
    license: input.license,
  };

  const containsEdge: GraphEdge = {
    from: fileId,
    to: symbolId,
    label: 'Contains',
    sourceTypeId: input.sourceTypeId,
  };

  return {
    node: graphNode,
    containsEdge,
    chunk: { nodeId: symbolId, text: chunkText },
  };
}

/** Pull a usable symbol name out of a declaration node. Tree-sitter
 *  exposes the name via the 'name' field for most declaration types;
 *  for declarations without one (anonymous default exports, etc.) we
 *  fall back to a synthesized "<anonymous>" sentinel and include the
 *  start line in the symbol id to keep it unique. */
function symbolName(node: TSNode): string | null {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;
  // Some node types put the name elsewhere; try a few common shapes.
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'identifier' || child?.type === 'property_identifier') {
      return child.text;
    }
  }
  // Anonymous declaration (e.g., `export default function() {}`) — emit
  // a sentinel so the chunk still gets indexed; line number on the id
  // keeps it unique within the file.
  return '<anonymous>';
}

/** Helper for tests: clear cached parsers + languages. Useful when test
 *  isolation matters more than perf. Production code should never call
 *  this — the caches are designed to live the life of the process. */
export function _resetForTests(): void {
  languageCache.clear();
  parserInitPromise = null;
}

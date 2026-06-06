/**
 * edge-context — CLI client for edge-context-server.
 *
 * Single audience: anyone (agent or human) talking to the local
 * edge-context-server over its UDS. Agents reach this binary via their
 * Bash tool capability per the `graphrag.md` SKILL; humans run it
 * directly from the terminal during bringup or debugging.
 *
 * Lives as a per-server peer package (not folded into the monolithic
 * harness-cli) for cold-start budget — agent workers may invoke this
 * dozens of times per task; the heavy harness-cli (TUI + react +
 * server orchestration deps) costs ~5× more per invocation. See
 * memory `project_per_server_cli_packages.md`.
 *
 * Per PRD § 4.4 (F37–F42): cold-start <300ms, --json escape hatch,
 * UDS-only transport. No network framework — built-in node:http via
 * uds-client.ts keeps imports + startup minimal.
 *
 * Entry shape:
 *   run({ argv, env, stdout, stderr }) → exitCode
 *
 * The export is testable: pass argv + env, capture stdout/stderr. The
 * `bin.ts` shim wires this to process.* and exits with the code.
 *
 * Subcommands map 1:1 to graphrag.* operations (PRD § 7.3):
 *   traverse, related, search, cypher (admin), stats, health
 */

import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import type {
  ContextQueryResult,
  CypherResult,
  IngestStatus,
  RelatedResult,
  TraverseResult,
  UploadEntry,
} from '@ecruz165/edge-context-server';
import { udsJson, UdsRequestError } from './uds-client.ts';

export interface RunIO {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const DEFAULT_SOCKET = '~/.harness/run/context.sock';

function expandHome(p: string, env: Record<string, string | undefined>): string {
  if (p.startsWith('~/')) {
    const home = env.HOME ?? homedir();
    return `${home}${p.slice(1)}`;
  }
  return p;
}

interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Minimal flag parser. Supports `--flag value`, `--flag=value`, and
 *  bare `--flag` (boolean). Stops at `--`. The command is the first
 *  non-flag token, so global flags can come before or after it
 *  (`edge-context --socket X stats` and `edge-context stats --json`
 *  both work). */
function parseArgs(argv: string[]): ParsedArgs {
  let command: string | undefined;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === '--') {
      const remainder = argv.slice(i + 1);
      if (!command && remainder.length > 0) {
        command = remainder[0];
        positionals.push(...remainder.slice(1));
      } else {
        positionals.push(...remainder);
      }
      break;
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq > 0) {
        flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      } else {
        const name = tok.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else if (!command) {
      command = tok;
    } else {
      positionals.push(tok);
    }
  }
  return { command, positionals, flags };
}

const USAGE = `edge-context — CLI client for edge-context-server (GraphRAG).

Usage:
  edge-context <command> [flags]

Read commands:
  traverse     Depth-bounded subgraph from a seed entity
  related      Single-predicate adjacency from a seed entity
  search       Hybrid BM25 + vector + graph search (RRF-fused)
  cypher       Run admin Cypher (UDS-only; READ-mode)
  stats        Graph metrics (nodes, edges, indexed labels)
  health       Server health probe
  metrics      Prometheus-style server metrics

Ingest commands:
  import-repo    Ingest a repo (--path <local> or --url <git>)
  upload         Upload a file (PDF, doc, image, dataset)
  crawl          Fetch a URL, run readability extraction, ingest as a Doc
  ingest-issues  Pull GitHub Issues into the graph (needs GITHUB_TOKEN on server)
  ingest-jira    Pull Jira issues by JQL (needs JIRA_TOKEN/EMAIL/BASE_URL on server)
  ingest-confluence  Pull Confluence space pages (needs CONFLUENCE_TOKEN/EMAIL/BASE_URL)
  ingests        List or get ingest status; cancel with --cancel
  uploads        List or delete uploads
  events         Tail ingestion events via WebSocket (--ingest <id> to filter)

Global flags:
  --socket <path>  UDS path. Default: ${DEFAULT_SOCKET}
                   Or set CONTEXT_SOCKET_PATH.
  --json           Emit JSON instead of human-readable output.
  --help           Show this help.

Search flags (hybrid graph + vector fusion):
  --top-k <n>            Result count (default 10).
  --label <CSV>          Restrict to these node labels.
  --expand-depth <n>     Graph-expansion hops from each vector seed.
                         0 = pure vector ANN. Default 1, max 2.
  --expand-predicate <CSV>  Restrict expansion to these relationship types.
  --predicate-weight <CSV>  Per-type weights, e.g. CALLS=1,MENTIONS=0.5.
                         Weak edge types contribute less to the graph signal.
  --hub-dampen           Soft-dampen graph pull by neighbor degree (hubs
                         contribute less without being excluded).
  --max-neighbors <n>    Cap neighbors contributed per seed (keeps strongest).
  --vector-weight <n>    RRF weight for the vector (semantic) signal. Default 1.0.
  --bm25-weight <n>      RRF weight for the BM25 (lexical) signal. 0 disables.
                         Default 1.0.
  --graph-weight <n>     RRF weight for the graph-expansion signal. 0 disables.
                         Default 0.5.
  --hub-ceiling <n>      Exclude nodes above this degree from expansion
                         (still retrievable by direct vector/BM25 match).

Hits are ranked by Reciprocal Rank Fusion of vector + BM25 + graph signals;
each hit shows which signals surfaced it (e.g. vector+bm25).

Examples:
  edge-context traverse --entity AuthService --depth 2
  edge-context search --query "rate limiting" --top-k 5 --expand-depth 1
  edge-context search --query "ERR_TOKEN_EXPIRED" --bm25-weight 2   # boost exact terms
  edge-context search --query "OIDC token refresh" --vector-weight 1.5 --hub-ceiling 150
  edge-context import-repo --name my-app --path ./src
  edge-context import-repo --name my-app --url git@github.com:org/repo.git --branch main
  edge-context upload ./design-spec.pdf --description "Mobile checkout v2"
  edge-context events --ingest ing_abc123
  edge-context cypher "MATCH (f:Function {name: \\"auth\\"}) RETURN f"
`;

export async function run(io: RunIO): Promise<number> {
  const { argv, env, stdout, stderr } = io;
  const parsed = parseArgs(argv);

  if (!parsed.command || parsed.flags.help) {
    stdout(USAGE);
    return parsed.command ? 0 : 2;
  }

  const socket = expandHome(
    (typeof parsed.flags.socket === 'string' ? parsed.flags.socket : undefined) ??
      env.CONTEXT_SOCKET_PATH ??
      DEFAULT_SOCKET,
    env,
  );
  const json = parsed.flags.json === true;

  try {
    switch (parsed.command) {
      case 'traverse':
        return await cmdTraverse(parsed, socket, json, stdout);
      case 'related':
        return await cmdRelated(parsed, socket, json, stdout);
      case 'search':
        return await cmdSearch(parsed, socket, json, stdout);
      case 'cypher':
        return await cmdCypher(parsed, socket, json, stdout);
      case 'stats':
        return await cmdStats(socket, json, stdout);
      case 'health':
        return await cmdHealth(socket, json, stdout);
      case 'metrics':
        return await cmdMetrics(socket, stdout);
      case 'import-repo':
        return await cmdImportRepo(parsed, socket, json, stdout);
      case 'upload':
        return await cmdUpload(parsed, socket, json, stdout);
      case 'crawl':
        return await cmdCrawl(parsed, socket, json, stdout);
      case 'ingest-issues':
        return await cmdIngestIssues(parsed, socket, json, stdout);
      case 'ingest-jira':
        return await cmdIngestJira(parsed, socket, json, stdout);
      case 'ingest-confluence':
        return await cmdIngestConfluence(parsed, socket, json, stdout);
      case 'ingests':
        return await cmdIngests(parsed, socket, json, stdout);
      case 'uploads':
        return await cmdUploads(parsed, socket, json, stdout);
      case 'events':
        return await cmdEvents(parsed, socket, stdout);
      default:
        stderr(`unknown command: ${parsed.command}\n`);
        stderr(USAGE);
        return 2;
    }
  } catch (err) {
    if (err instanceof UdsRequestError) {
      stderr(`error: ${err.message} (status ${err.status})\n`);
      return 1;
    }
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      stderr(`error: socket not found at ${socket}\n`);
      stderr('hint: is edge-context-server running? Check $CONTEXT_SOCKET_PATH or pass --socket.\n');
      return 1;
    }
    if (e.code === 'ECONNREFUSED') {
      stderr(`error: connection refused at ${socket} (server not listening)\n`);
      return 1;
    }
    stderr(`error: ${e.message}\n`);
    return 1;
  }
}

// ─── command handlers ────────────────────────────────────────────────

async function cmdTraverse(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
): Promise<number> {
  const entity = stringFlag(parsed.flags, 'entity');
  const depth = numberFlag(parsed.flags, 'depth');
  if (!entity || depth == null) {
    throw new Error('traverse requires --entity <id> and --depth <n>');
  }
  const predicates = stringFlag(parsed.flags, 'predicate');
  const productId = stringFlag(parsed.flags, 'product');
  const limit = numberFlag(parsed.flags, 'limit');

  const body: Record<string, unknown> = { entity, depth };
  if (predicates) body.predicates = predicates.split(',').map((s) => s.trim()).filter(Boolean);
  if (productId) body.productId = productId;
  if (limit != null) body.limit = limit;

  const r = await udsJson<{ result: TraverseResult }>(socket, 'POST', '/v1/traverse', body);
  if (json) {
    stdout(`${JSON.stringify(r.body.result)}\n`);
  } else {
    stdout(formatTraverse(r.body.result));
  }
  return 0;
}

async function cmdRelated(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
): Promise<number> {
  const entity = stringFlag(parsed.flags, 'entity');
  const predicate = stringFlag(parsed.flags, 'predicate');
  const depth = numberFlag(parsed.flags, 'depth');
  if (!entity || !predicate || depth == null) {
    throw new Error('related requires --entity <id> --predicate <NAME> --depth <n>');
  }
  const productId = stringFlag(parsed.flags, 'product');
  const limit = numberFlag(parsed.flags, 'limit');

  const body: Record<string, unknown> = { entity, predicate, depth };
  if (productId) body.productId = productId;
  if (limit != null) body.limit = limit;

  const r = await udsJson<{ result: RelatedResult }>(socket, 'POST', '/v1/related', body);
  if (json) {
    stdout(`${JSON.stringify(r.body.result)}\n`);
  } else {
    stdout(formatRelated(r.body.result));
  }
  return 0;
}

async function cmdSearch(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
): Promise<number> {
  const q = stringFlag(parsed.flags, 'query');
  if (!q) throw new Error('search requires --query "<text>"');
  const topK = numberFlag(parsed.flags, 'top-k') ?? numberFlag(parsed.flags, 'topK');
  const productId = stringFlag(parsed.flags, 'product');
  const labels = stringFlag(parsed.flags, 'label');
  // Hybrid-fusion knobs (server defaults apply when omitted).
  const expandDepth = numberFlag(parsed.flags, 'expand-depth');
  const vectorWeight = numberFlag(parsed.flags, 'vector-weight');
  const bm25Weight = numberFlag(parsed.flags, 'bm25-weight');
  const graphWeight = numberFlag(parsed.flags, 'graph-weight');
  const hubCeiling = numberFlag(parsed.flags, 'hub-ceiling');
  const expandPredicates = stringFlag(parsed.flags, 'expand-predicate');
  const predicateWeightStr = stringFlag(parsed.flags, 'predicate-weight');
  const hubDampen = parsed.flags['hub-dampen'] === true;
  const maxNeighbors = numberFlag(parsed.flags, 'max-neighbors');

  const body: Record<string, unknown> = { q };
  if (topK != null) body.topK = topK;
  if (productId) body.productId = productId;
  if (labels) body.labels = labels.split(',').map((s) => s.trim()).filter(Boolean);
  if (expandDepth != null) body.expandDepth = expandDepth;
  if (vectorWeight != null) body.vectorWeight = vectorWeight;
  if (bm25Weight != null) body.bm25Weight = bm25Weight;
  if (graphWeight != null) body.graphWeight = graphWeight;
  if (hubCeiling != null) body.hubDegreeCeiling = hubCeiling;
  if (expandPredicates)
    body.expandPredicates = expandPredicates.split(',').map((s) => s.trim()).filter(Boolean);
  if (predicateWeightStr) {
    // Parse `CALLS=1,MENTIONS=0.5` → { CALLS: 1, MENTIONS: 0.5 }.
    const w: Record<string, number> = {};
    for (const pair of predicateWeightStr.split(',')) {
      const [k, v] = pair.split('=');
      const n = Number(v);
      if (k && k.trim() && Number.isFinite(n)) w[k.trim()] = n;
    }
    if (Object.keys(w).length > 0) body.expandPredicateWeights = w;
  }
  if (hubDampen) body.hubDampening = true;
  if (maxNeighbors != null) body.maxNeighborsPerSeed = maxNeighbors;

  const r = await udsJson<{ result: ContextQueryResult }>(socket, 'POST', '/v1/context/query', body);
  if (json) {
    stdout(`${JSON.stringify(r.body.result)}\n`);
  } else {
    stdout(formatSearch(r.body.result));
  }
  return 0;
}

async function cmdCypher(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
): Promise<number> {
  const cypher = parsed.positionals[0];
  if (!cypher) {
    throw new Error('cypher requires the query as a positional arg, e.g. cypher "MATCH (n) RETURN n LIMIT 1"');
  }
  const paramsRaw = stringFlag(parsed.flags, 'params');
  let params: Record<string, unknown> | undefined;
  if (paramsRaw) {
    try {
      const parsedJson = JSON.parse(paramsRaw);
      if (parsedJson && typeof parsedJson === 'object') {
        params = parsedJson as Record<string, unknown>;
      } else {
        throw new Error('--params must be a JSON object');
      }
    } catch (err) {
      throw new Error(`--params is not valid JSON: ${(err as Error).message}`);
    }
  }
  const limit = numberFlag(parsed.flags, 'limit');
  const body: Record<string, unknown> = { cypher };
  if (params) body.params = params;
  if (limit != null) body.limit = limit;

  const r = await udsJson<{ result: CypherResult }>(socket, 'POST', '/v1/query', body);
  if (json) {
    stdout(`${JSON.stringify(r.body.result)}\n`);
  } else {
    stdout(formatCypher(r.body.result));
  }
  return 0;
}

async function cmdStats(
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
): Promise<number> {
  const r = await udsJson<Record<string, unknown>>(socket, 'GET', '/v1/stats');
  if (json) {
    stdout(`${JSON.stringify(r.body)}\n`);
  } else {
    stdout(
      `nodes: ${r.body.nodeCount}\n` +
        `edges: ${r.body.edgeCount}\n` +
        `indexedLabels: ${(r.body.indexedLabels as string[] | undefined)?.join(', ') ?? '(none)'}\n`,
    );
  }
  return 0;
}

async function cmdHealth(
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
): Promise<number> {
  const r = await udsJson<Record<string, unknown>>(socket, 'GET', '/health');
  if (json) {
    stdout(`${JSON.stringify(r.body)}\n`);
  } else {
    stdout(
      `state: ${r.body.state}\n` +
        `backend: ${r.body.backend ?? '(none)'}\n` +
        `uptime: ${r.body.uptimeMs}ms\n`,
    );
  }
  return 0;
}

// ─── flag helpers ─────────────────────────────────────────────────────

function stringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

function numberFlag(flags: Record<string, string | boolean>, name: string): number | undefined {
  const v = flags[name];
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// ─── output formatters ────────────────────────────────────────────────

function formatTraverse(r: TraverseResult): string {
  const lines: string[] = [];
  lines.push(`entity: ${r.entity}   depth: ${r.depth}   nodes: ${r.nodes.length}   edges: ${r.edges.length}${r.truncated ? '   (truncated)' : ''}`);
  lines.push('');
  lines.push('NODES:');
  for (const n of r.nodes) {
    const name = n.properties.name ?? n.properties.title ?? n.nodeId;
    lines.push(`  [d=${n.distance}] ${n.label.padEnd(12)} ${n.nodeId}  ${name !== n.nodeId ? `(${name})` : ''}`);
  }
  if (r.edges.length) {
    lines.push('');
    lines.push('EDGES:');
    for (const e of r.edges) {
      lines.push(`  ${e.fromNodeId} -[:${e.type}]-> ${e.toNodeId}`);
    }
  }
  return lines.join('\n') + '\n';
}

function formatRelated(r: RelatedResult): string {
  const lines: string[] = [];
  lines.push(`entity: ${r.entity}   predicate: ${r.predicate}   depth: ${r.depth}   hits: ${r.hits.length}${r.truncated ? '   (truncated)' : ''}`);
  lines.push('');
  for (const h of r.hits) {
    const name = h.properties.name ?? h.properties.title ?? h.nodeId;
    lines.push(`  [d=${h.distance}] ${h.label.padEnd(12)} ${h.nodeId}  ${name !== h.nodeId ? `(${name})` : ''}`);
  }
  return lines.join('\n') + '\n';
}

function formatSearch(r: ContextQueryResult): string {
  const lines: string[] = [];
  lines.push(`q: ${r.q}   hits: ${r.hits.length}   topK: ${r.topK}   embed: ${r.embeddingMs}ms   search: ${r.searchMs}ms`);
  lines.push('');
  for (const h of r.hits) {
    const text = (h.properties.text ?? h.properties.title ?? h.properties.name ?? '') as string;
    const snippet = text.length > 100 ? text.slice(0, 100) + '…' : text;
    lines.push(`  ${h.score.toFixed(3)}  ${(h.via ?? '?').padEnd(16)} ${h.label.padEnd(12)} ${h.nodeId}`);
    if (snippet) lines.push(`         ${snippet}`);
  }
  return lines.join('\n') + '\n';
}

function formatCypher(r: CypherResult): string {
  const lines: string[] = [];
  lines.push(`columns: ${r.columns.join(', ')}   rows: ${r.rowCount}${r.truncated ? '   (truncated)' : ''}`);
  lines.push('');
  for (const row of r.rows) {
    lines.push(JSON.stringify(row));
  }
  return lines.join('\n') + '\n';
}

// ─── ingest / upload / events command handlers ───────────────────────

async function cmdMetrics(socket: string, stdout: (s: string) => void): Promise<number> {
  const r = await udsJson<string>(socket, 'GET', '/metrics');
  stdout(typeof r.body === 'string' ? r.body : `${r.body}\n`);
  return 0;
}

async function cmdImportRepo(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
): Promise<number> {
  const name = stringFlag(parsed.flags, 'name');
  if (!name) throw new Error('import-repo requires --name <id>');
  const path = stringFlag(parsed.flags, 'path');
  const url = stringFlag(parsed.flags, 'url');
  const branch = stringFlag(parsed.flags, 'branch');
  const productId = stringFlag(parsed.flags, 'product');
  const sourceTypeId = stringFlag(parsed.flags, 'source-type');
  if (!path && !url) {
    throw new Error('import-repo requires --path <local> or --url <git>');
  }
  if (path && url) {
    throw new Error('import-repo: pass either --path or --url, not both');
  }
  const source = path
    ? { type: 'local' as const, path }
    : { type: 'git' as const, cloneUrl: url!, ...(branch ? { branch } : {}) };

  const body: Record<string, unknown> = { name, source };
  if (productId) body.productId = productId;
  if (sourceTypeId) body.sourceTypeId = sourceTypeId;

  const r = await udsJson<{ ingestId: string }>(socket, 'POST', '/v1/ingest/repo', body);
  if (json) {
    stdout(`${JSON.stringify(r.body)}\n`);
  } else {
    stdout(
      `started ingest ${r.body.ingestId}\n` +
        `  watch progress:  edge-context events --ingest ${r.body.ingestId}\n` +
        `  poll status:     edge-context ingests ${r.body.ingestId}\n`,
    );
  }
  return 0;
}

async function cmdUpload(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
): Promise<number> {
  const filePath = parsed.positionals[0];
  if (!filePath) {
    throw new Error('upload requires a file path as the first positional arg');
  }
  const description = stringFlag(parsed.flags, 'description');
  const contentType = stringFlag(parsed.flags, 'content-type');
  const productId = stringFlag(parsed.flags, 'product');

  const bytes = await readFile(filePath);
  const filename = basename(filePath);
  const boundary = `----edge-context-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const parts: Buffer[] = [];
  const addText = (name: string, value: string) => {
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    parts.push(Buffer.from(`${value}\r\n`));
  };
  if (description) addText('description', description);
  if (contentType) addText('contentType', contentType);
  if (productId) addText('productId', productId);
  parts.push(Buffer.from(`--${boundary}\r\n`));
  parts.push(
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`),
  );
  parts.push(Buffer.from(`Content-Type: ${contentType ?? 'application/octet-stream'}\r\n\r\n`));
  parts.push(bytes);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const r = await new Promise<{ status: number; body: { ingestId: string; entry: UploadEntry } }>(
    (resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: socket,
          path: '/v1/ingest/upload',
          method: 'POST',
          headers: {
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'content-length': String(body.length),
          },
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c.toString()));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) });
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    },
  );
  if (r.status >= 400) {
    throw new UdsRequestError(`upload failed: HTTP ${r.status}`, r.status, r.body);
  }
  if (json) {
    stdout(`${JSON.stringify(r.body)}\n`);
  } else {
    stdout(
      `uploaded ${r.body.entry.docId} (${r.body.entry.filename}, ${r.body.entry.sizeBytes} bytes)\n` +
        `  localPath: ${r.body.entry.localPath}\n` +
        `  ingestId:  ${r.body.ingestId}\n`,
    );
  }
  return 0;
}

async function cmdIngestIssues(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
): Promise<number> {
  const repo = stringFlag(parsed.flags, 'repo');
  if (!repo) throw new Error('ingest-issues requires --repo <owner/name>');
  const name = stringFlag(parsed.flags, 'name') ?? `gh-${repo.replace('/', '-')}`;
  const labels = stringFlag(parsed.flags, 'labels');
  const state = stringFlag(parsed.flags, 'state');
  const since = stringFlag(parsed.flags, 'since');
  const productId = stringFlag(parsed.flags, 'product');
  const maxPages = numberFlag(parsed.flags, 'max-pages');

  const body: Record<string, unknown> = { name, repo };
  if (labels) body.labels = labels.split(',').map((s) => s.trim()).filter(Boolean);
  if (state === 'open' || state === 'closed' || state === 'all') body.state = state;
  if (since) body.since = since;
  if (productId) body.productId = productId;
  if (maxPages != null) body.maxPages = maxPages;

  const r = await udsJson<{ ingestId: string }>(
    socket,
    'POST',
    '/v1/ingest/github-issues',
    body,
  );
  if (json) {
    stdout(`${JSON.stringify(r.body)}\n`);
  } else {
    stdout(
      `started GitHub Issues ingest ${r.body.ingestId} for ${repo}\n` +
        `  watch progress:  edge-context events --ingest ${r.body.ingestId}\n` +
        `  poll status:     edge-context ingests ${r.body.ingestId}\n`,
    );
  }
  return 0;
}

async function cmdIngestJira(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
): Promise<number> {
  const jql = stringFlag(parsed.flags, 'jql') ?? parsed.positionals[0];
  if (!jql) throw new Error('ingest-jira requires --jql "<jql>" or as positional arg');
  const projMatch = jql.match(/project\s*=\s*"?([\w-]+)"?/i);
  const name = stringFlag(parsed.flags, 'name') ?? `jira-${projMatch?.[1] ?? 'all'}`;
  const productId = stringFlag(parsed.flags, 'product');
  const maxResults = numberFlag(parsed.flags, 'max-results');

  const body: Record<string, unknown> = { name, jql };
  if (productId) body.productId = productId;
  if (maxResults != null) body.maxResults = maxResults;

  const r = await udsJson<{ ingestId: string }>(socket, 'POST', '/v1/ingest/jira', body);
  if (json) {
    stdout(`${JSON.stringify(r.body)}\n`);
  } else {
    stdout(
      `started Jira ingest ${r.body.ingestId} for jql='${jql}'\n` +
        `  watch progress:  edge-context events --ingest ${r.body.ingestId}\n`,
    );
  }
  return 0;
}

async function cmdIngestConfluence(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
): Promise<number> {
  const space = stringFlag(parsed.flags, 'space') ?? parsed.positionals[0];
  if (!space) throw new Error('ingest-confluence requires --space <KEY> or as positional arg');
  const name = stringFlag(parsed.flags, 'name') ?? `confluence-${space}`;
  const productId = stringFlag(parsed.flags, 'product');
  const maxResults = numberFlag(parsed.flags, 'max-results');

  const body: Record<string, unknown> = { name, space };
  if (productId) body.productId = productId;
  if (maxResults != null) body.maxResults = maxResults;

  const r = await udsJson<{ ingestId: string }>(socket, 'POST', '/v1/ingest/confluence', body);
  if (json) {
    stdout(`${JSON.stringify(r.body)}\n`);
  } else {
    stdout(
      `started Confluence ingest ${r.body.ingestId} for space=${space}\n` +
        `  watch progress:  edge-context events --ingest ${r.body.ingestId}\n`,
    );
  }
  return 0;
}

async function cmdCrawl(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
): Promise<number> {
  const url = parsed.positionals[0] ?? stringFlag(parsed.flags, 'url');
  const name =
    stringFlag(parsed.flags, 'name') ??
    (url ? new URL(url).hostname.replace(/[^A-Za-z0-9._-]+/g, '_') : undefined);
  if (!url || !name) {
    throw new Error('crawl requires <url> as positional arg or --url; --name optional');
  }
  const productId = stringFlag(parsed.flags, 'product');
  const rateLimit = numberFlag(parsed.flags, 'rate-limit');
  const ifNoneMatch = stringFlag(parsed.flags, 'if-none-match');
  const ifModifiedSince = stringFlag(parsed.flags, 'if-modified-since');
  const scopeFlag = stringFlag(parsed.flags, 'scope');
  const scope =
    scopeFlag === 'page' || scopeFlag === 'subtree' || scopeFlag === 'site' ? scopeFlag : undefined;
  const maxDepth = numberFlag(parsed.flags, 'max-depth');
  const maxPages = numberFlag(parsed.flags, 'max-pages');
  const allowedDomains = stringFlag(parsed.flags, 'allowed-domains');

  const body: Record<string, unknown> = { name, url };
  if (scope) body.scope = scope;
  if (maxDepth != null) body.maxDepth = maxDepth;
  if (maxPages != null) body.maxPages = maxPages;
  if (allowedDomains)
    body.allowedDomains = allowedDomains.split(',').map((s) => s.trim()).filter(Boolean);
  if (productId) body.productId = productId;
  if (rateLimit != null) body.rateLimitPerHost = rateLimit;
  if (ifNoneMatch) body.ifNoneMatch = ifNoneMatch;
  if (ifModifiedSince) body.ifModifiedSince = ifModifiedSince;

  const r = await udsJson<{ ingestId: string }>(socket, 'POST', '/v1/ingest/crawl', body);
  if (json) {
    stdout(`${JSON.stringify(r.body)}\n`);
  } else {
    stdout(
      `started crawl ${r.body.ingestId} for ${url}\n` +
        `  watch progress:  edge-context events --ingest ${r.body.ingestId}\n`,
    );
  }
  return 0;
}

async function cmdIngests(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
): Promise<number> {
  const positional = parsed.positionals[0];
  const cancel = parsed.flags.cancel === true;

  if (cancel) {
    if (!positional) throw new Error('ingests --cancel requires <ingestId> as positional arg');
    const r = await udsJson<unknown>(socket, 'DELETE', `/v1/ingest/${positional}`);
    if (json) stdout(`${JSON.stringify({ cancelled: positional })}\n`);
    else stdout(`cancelled ${positional}\n`);
    return 0;
  }

  if (positional) {
    const r = await udsJson<{ status: IngestStatus }>(socket, 'GET', `/v1/ingest/${positional}`);
    if (json) {
      stdout(`${JSON.stringify(r.body.status)}\n`);
    } else {
      stdout(formatIngestStatus(r.body.status));
    }
    return 0;
  }

  const r = await udsJson<{ ingests: IngestStatus[] }>(socket, 'GET', '/v1/ingest');
  if (json) {
    stdout(`${JSON.stringify(r.body.ingests)}\n`);
  } else {
    stdout(formatIngestList(r.body.ingests));
  }
  return 0;
}

async function cmdUploads(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
): Promise<number> {
  const positional = parsed.positionals[0];
  const remove = parsed.flags.delete === true;

  if (remove) {
    if (!positional) throw new Error('uploads --delete requires <docId> as positional arg');
    await udsJson<unknown>(socket, 'DELETE', `/v1/uploads/${positional}`);
    if (json) stdout(`${JSON.stringify({ deleted: positional })}\n`);
    else stdout(`deleted ${positional}\n`);
    return 0;
  }

  const r = await udsJson<{ uploads: UploadEntry[] }>(socket, 'GET', '/v1/uploads');
  if (json) {
    stdout(`${JSON.stringify(r.body.uploads)}\n`);
  } else {
    stdout(formatUploadList(r.body.uploads));
  }
  return 0;
}

async function cmdEvents(
  parsed: ParsedArgs,
  socket: string,
  stdout: (s: string) => void,
): Promise<number> {
  // Lazy-load `ws` so the cold-start budget for the common (non-events)
  // commands stays minimal.
  const { default: WebSocket } = await import('ws');
  const filter = stringFlag(parsed.flags, 'ingest');

  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${socket}:/v1/ingest/events`);
    ws.on('error', (err) => reject(err));
    ws.on('open', () => {
      if (filter) ws.send(JSON.stringify({ subscribe: filter }));
    });
    ws.on('message', (data) => {
      stdout(`${data.toString()}\n`);
    });
    ws.on('close', () => resolve(0));
    process.on('SIGINT', () => {
      ws.close();
      resolve(0);
    });
  });
}

// ─── ingest / upload formatters ───────────────────────────────────────

function formatIngestStatus(s: IngestStatus): string {
  const lines: string[] = [];
  lines.push(`${s.ingestId}   kind=${s.kind}   state=${s.state}`);
  if (s.productId) lines.push(`  product:    ${s.productId}`);
  lines.push(`  startedAt:  ${s.startedAt}`);
  if (s.completedAt) lines.push(`  completedAt: ${s.completedAt}`);
  if (s.summary) {
    lines.push(
      `  summary:    files=${s.summary.filesIngested}  chunks=${s.summary.chunksWritten}  vectors=${s.summary.vectorsWritten}  errors=${s.summary.errors}`,
    );
  }
  if (s.error) lines.push(`  error:      ${s.error}`);
  if (s.events.length > 0) {
    lines.push(`  events:     ${s.events.length} buffered`);
    const tail = s.events.slice(-5);
    for (const ev of tail) {
      lines.push(`    ${ev.kind}`);
    }
  }
  return lines.join('\n') + '\n';
}

function formatIngestList(ingests: IngestStatus[]): string {
  if (ingests.length === 0) return '(no ingests)\n';
  const lines: string[] = [];
  lines.push('INGEST_ID                 KIND     STATE       PRODUCT       STARTED');
  for (const s of ingests) {
    lines.push(
      `${s.ingestId.padEnd(25)} ${s.kind.padEnd(8)} ${s.state.padEnd(11)} ${(s.productId ?? '-').padEnd(13)} ${s.startedAt}`,
    );
  }
  return lines.join('\n') + '\n';
}

function formatUploadList(uploads: UploadEntry[]): string {
  if (uploads.length === 0) return '(no uploads)\n';
  const lines: string[] = [];
  lines.push('DOC_ID            FILENAME                       SIZE     CONTENT_TYPE        UPLOADED');
  for (const u of uploads) {
    lines.push(
      `${u.docId.padEnd(17)} ${u.filename.slice(0, 30).padEnd(30)} ${String(u.sizeBytes).padStart(8)} ${u.contentType.padEnd(19)} ${u.uploadedAt}`,
    );
  }
  return lines.join('\n') + '\n';
}

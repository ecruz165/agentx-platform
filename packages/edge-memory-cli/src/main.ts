/**
 * edge-memory — CLI client for edge-memory-server.
 *
 * Single audience: anyone (agent or human) talking to the local
 * edge-memory-server over its UDS. Agents reach this binary via their
 * Bash tool capability per the `memory.md` SKILL; humans run it
 * directly during bringup or debugging.
 *
 * Lives as a per-server peer package (not folded into the monolithic
 * harness-cli) for cold-start budget. See memory
 * `project_per_server_cli_packages.md`. Built-in `node:http` over UDS
 * keeps startup minimal — no fetch dispatcher, no framework imports.
 *
 * Subcommands:
 *   put       Store an entry (key + value, optional scope)
 *   query     Retrieve entries (structured / recent / similarity)
 *   forget    Delete entries by predicate (key, scope, olderThan)
 *   health    Server health probe
 *
 * Entry shape:
 *   run({ argv, env, stdout, stderr }) → exitCode
 *
 * Testable: pass argv + env, capture stdout/stderr. The `bin.ts` shim
 * wires this to process.* and exits with the code.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type {
  AuditEvent,
  MemoryForgetResult,
  MemoryQueryResult,
  MemoryScope,
} from '@ecruz165/edge-memory-server';
import { UdsRequestError, udsJson, udsRequest } from './uds-client.ts';

export interface RunIO {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const DEFAULT_SOCKET = '~/.harness/run/memory.sock';

/** PRD F27: socket layout for a non-default workspace. The harness
 *  installs each workspace under ~/.harness/workspaces/<name>/, with
 *  the per-workspace memory daemon's socket at run/memory.sock under
 *  that root. Single-workspace setups don't pay for the indirection;
 *  --workspace is opt-in. */
function workspaceSocket(name: string): string {
  return `~/.harness/workspaces/${name}/run/memory.sock`;
}

const SCOPE_KEYS: ReadonlyArray<keyof MemoryScope> = [
  'jobId',
  'productId',
  'userId',
  'sessionId',
  'organizationId',
  'topic',
] as const;

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
  /** Repeated --scope k:v flags accumulated into a MemoryScope. */
  scope: MemoryScope;
}

/** Minimal flag parser. Supports `--flag value`, `--flag=value`, and
 *  bare `--flag` (boolean). `--scope key:value` may repeat — each adds
 *  to the merged scope. Stops at `--`. */
function parseArgs(argv: string[]): ParsedArgs {
  let command: string | undefined;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const scope: MemoryScope = {};

  const setScopeFromString = (raw: string): void => {
    const colon = raw.indexOf(':');
    if (colon <= 0) return;
    const key = raw.slice(0, colon) as keyof MemoryScope;
    const value = raw.slice(colon + 1);
    if (SCOPE_KEYS.includes(key)) {
      scope[key] = value;
    }
  };

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
      let name: string;
      let value: string | boolean;
      if (eq > 0) {
        name = tok.slice(2, eq);
        value = tok.slice(eq + 1);
      } else {
        name = tok.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          value = next;
          i++;
        } else {
          value = true;
        }
      }
      // --scope can repeat — accumulate into the scope object.
      if (name === 'scope' && typeof value === 'string') {
        setScopeFromString(value);
      } else {
        flags[name] = value;
      }
    } else if (!command) {
      command = tok;
    } else {
      positionals.push(tok);
    }
  }
  return { command, positionals, flags, scope };
}

const USAGE = `edge-memory — CLI client for edge-memory-server.

Usage:
  edge-memory <command> [flags]

Commands:
  put       Store an entry. Positional: <key>; --value <text>
  query     Retrieve entries by query type (--type structured|recent|similarity)
  forget    Delete entries matching a predicate
  export    Stream matching entries as JSONL (one object per line)
  import    Read JSONL from stdin or --in <file>; put each line
  audit     Read the audit log (filter by --op, --since, --until, --scope, --actor)
  tag       Tag entries positive/negative (--feedback positive|negative; --source ...)
  consolidate  Promote tagged entries from --from <scope> to --to <scope>
  cleanup   Delete unconfirmed entries within --scope (PRD F19; job-end pruning)
  snapshot  Capture entries matching --scope into a snapshot (PRD F5)
  restore   Restore a snapshot by --snapshot <id> (mode: --replace [default] or --merge)
  health    Server health probe

Global flags:
  --socket <path>     UDS path. Default: ${DEFAULT_SOCKET}
                      Or set MEMORY_SOCKET_PATH.
  --workspace <name>  Use ~/.harness/workspaces/<name>/run/memory.sock
                      (mutually exclusive with --socket).
  --scope key:value   Scope tag. May repeat. Keys: jobId, productId, userId,
                      sessionId, organizationId, topic.
  --json              Emit JSON instead of human-readable output.
  --help              Show this help.

Examples:
  edge-memory put refactor-plan --value "split auth into broker + chat"
  edge-memory put refactor-plan --value "..." --scope productId:web --scope userId:alice
  edge-memory query --type structured --key refactor-plan
  edge-memory query --type recent --limit 5 --scope productId:web
  edge-memory query --type similarity --q "auth refactor" --top-k 3
  edge-memory forget --scope productId:web
  edge-memory forget --key refactor-plan --older-than 2026-01-01T00:00:00Z
  edge-memory export --scope productId:web > backup.jsonl
  edge-memory export --type recent --limit 100 --out recent.jsonl
  cat backup.jsonl | edge-memory import
  edge-memory import --in backup.jsonl
  edge-memory audit --op forget --since 2026-05-01T00:00:00Z
  edge-memory audit --scope userId:alice --limit 50
  edge-memory tag --scope jobId:job_42 --feedback positive --source phase-success
  edge-memory tag --entry mem_xyz --feedback negative --source pr-rejected
  edge-memory tag --scope productId:web --feedback positive --overwrite
  edge-memory consolidate --from jobId:job_42 --to productId:web
  edge-memory consolidate --from jobId:j --to userId:alice --strategy feedback-summarize
  edge-memory consolidate --from jobId:j --to productId:web --feedback-filter positive --keep-source
  edge-memory cleanup --scope jobId:job_42
  edge-memory snapshot --scope sessionId:abc-123
  edge-memory restore --snapshot snap_123 --merge
  edge-memory health --json
`;

export async function run(io: RunIO): Promise<number> {
  const { argv, env, stdout, stderr } = io;
  const parsed = parseArgs(argv);

  if (!parsed.command || parsed.flags.help) {
    stdout(USAGE);
    return parsed.command ? 0 : 2;
  }

  // Socket precedence (highest first): --socket > --workspace > MEMORY_SOCKET_PATH > default.
  // --workspace and --socket are mutually exclusive (different abstractions
  // — one names a workspace, the other names a path); both set is a usage error.
  const explicitSocket =
    typeof parsed.flags.socket === 'string' ? (parsed.flags.socket as string) : undefined;
  const workspaceName =
    typeof parsed.flags.workspace === 'string' ? (parsed.flags.workspace as string) : undefined;
  if (explicitSocket && workspaceName) {
    stderr('error: --socket and --workspace are mutually exclusive\n');
    return 2;
  }
  const socket = expandHome(
    explicitSocket ??
      (workspaceName ? workspaceSocket(workspaceName) : undefined) ??
      env.MEMORY_SOCKET_PATH ??
      DEFAULT_SOCKET,
    env,
  );
  const json = parsed.flags.json === true;

  try {
    switch (parsed.command) {
      case 'put':
        return await cmdPut(parsed, socket, json, stdout);
      case 'query':
        return await cmdQuery(parsed, socket, json, stdout);
      case 'forget':
        return await cmdForget(parsed, socket, json, stdout);
      case 'export':
        return await cmdExport(parsed, socket, stdout);
      case 'import':
        return await cmdImport(parsed, socket, json, stdout, stderr);
      case 'audit':
        return await cmdAudit(parsed, socket, json, stdout);
      case 'tag':
        return await cmdTag(parsed, socket, json, stdout, stderr);
      case 'consolidate':
        return await cmdConsolidate(parsed, socket, json, stdout, stderr);
      case 'cleanup':
        return await cmdCleanup(parsed, socket, json, stdout, stderr);
      case 'snapshot':
        return await cmdSnapshot(parsed, socket, json, stdout, stderr);
      case 'restore':
        return await cmdRestore(parsed, socket, json, stdout, stderr);
      case 'health':
        return await cmdHealth(socket, json, stdout);
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
      stderr('hint: is edge-memory-server running? Check $MEMORY_SOCKET_PATH or pass --socket.\n');
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

// ─── command handlers ─────────────────────────────────────────────────

async function cmdPut(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
): Promise<number> {
  const key = parsed.positionals[0];
  const value = stringFlag(parsed.flags, 'value');
  if (!key)
    throw new Error('put requires a positional key, e.g. `edge-memory put plan --value "..."`');
  if (value === undefined) throw new Error('put requires --value <text>');

  const body: Record<string, unknown> = { key, value };
  if (Object.keys(parsed.scope).length > 0) body.scope = parsed.scope;

  const r = await udsJson<{ entry: { id: string; key: string; createdAt: string } }>(
    socket,
    'POST',
    '/v1/memory/put',
    body,
  );
  if (json) {
    stdout(`${JSON.stringify(r.body)}\n`);
  } else {
    stdout(`stored ${r.body.entry.id} (key=${r.body.entry.key}) at ${r.body.entry.createdAt}\n`);
  }
  return 0;
}

async function cmdQuery(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
): Promise<number> {
  const type = stringFlag(parsed.flags, 'type') ?? 'structured';
  const body: Record<string, unknown> = { kind: type };
  if (Object.keys(parsed.scope).length > 0) body.scope = parsed.scope;

  if (type === 'structured') {
    const key = stringFlag(parsed.flags, 'key');
    if (key !== undefined) body.key = key;
  } else if (type === 'recent') {
    const limit = numberFlag(parsed.flags, 'limit');
    if (limit != null) body.limit = limit;
  } else if (type === 'similarity') {
    const q = stringFlag(parsed.flags, 'q') ?? stringFlag(parsed.flags, 'query');
    if (!q) throw new Error('similarity query requires --q "<text>" or --query "<text>"');
    body.q = q;
    const topK = numberFlag(parsed.flags, 'top-k') ?? numberFlag(parsed.flags, 'topK');
    if (topK != null) body.topK = topK;
  } else if (type === 'graph') {
    const from = stringFlag(parsed.flags, 'from');
    if (!from) throw new Error('graph query requires --from <entryId>');
    body.from = from;
    const depth = numberFlag(parsed.flags, 'depth');
    if (depth != null) body.depth = depth;
  } else {
    throw new Error(`unknown --type ${type} (expected: structured | recent | similarity | graph)`);
  }

  const r = await udsJson<{ result: MemoryQueryResult }>(socket, 'POST', '/v1/memory/query', body);
  if (json) {
    stdout(`${JSON.stringify(r.body.result)}\n`);
    return 0;
  }
  stdout(formatQueryResult(r.body.result));
  return 0;
}

async function cmdForget(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
): Promise<number> {
  const body: Record<string, unknown> = {};
  if (Object.keys(parsed.scope).length > 0) body.scope = parsed.scope;
  const key = stringFlag(parsed.flags, 'key');
  if (key !== undefined) body.key = key;
  const olderThan = stringFlag(parsed.flags, 'older-than') ?? stringFlag(parsed.flags, 'olderThan');
  if (olderThan !== undefined) body.olderThan = olderThan;

  const r = await udsJson<{ result: MemoryForgetResult }>(
    socket,
    'POST',
    '/v1/memory/forget',
    body,
  );
  if (json) {
    stdout(`${JSON.stringify(r.body.result)}\n`);
  } else {
    stdout(`deleted ${r.body.result.deleted} entries\n`);
    if (r.body.result.deletedIds.length > 0 && r.body.result.deletedIds.length <= 10) {
      stdout(`  ids: ${r.body.result.deletedIds.join(', ')}\n`);
    } else if (r.body.result.deletedIds.length > 10) {
      stdout(`  sample (first 10): ${r.body.result.deletedIds.slice(0, 10).join(', ')}\n`);
    }
  }
  return 0;
}

/**
 * Export matching entries as JSONL. Default destination is stdout
 * (so `edge-memory export > backup.jsonl` works); --out <file>
 * writes to disk instead.
 *
 * Predicate flags map to the same MemoryQuery shape used by `query`:
 *   --type structured | recent  (similarity / graph not supported for
 *                                export — server returns 400)
 *   --key <key>                 (structured only)
 *   --limit <n>                 (recent only)
 *   --scope k:v                 (any)
 *
 * No flags → exports everything via structured-no-filter.
 */
async function cmdExport(
  parsed: ParsedArgs,
  socket: string,
  stdout: (s: string) => void,
): Promise<number> {
  const type = stringFlag(parsed.flags, 'type') ?? 'structured';
  const body: Record<string, unknown> = { kind: type };
  if (Object.keys(parsed.scope).length > 0) body.scope = parsed.scope;

  if (type === 'structured') {
    const key = stringFlag(parsed.flags, 'key');
    if (key !== undefined) body.key = key;
  } else if (type === 'recent') {
    const limit = numberFlag(parsed.flags, 'limit');
    if (limit != null) body.limit = limit;
  } else {
    throw new Error(`export --type ${type} not supported (use structured or recent)`);
  }

  // Direct request — the response is JSONL (text/plain), not a single
  // JSON object, so udsJson's parse-on-success path doesn't fit.
  const lines = await fetchExport(socket, body);
  const out = stringFlag(parsed.flags, 'out');
  if (out) {
    await writeFile(out, lines, 'utf8');
  } else {
    stdout(lines);
  }
  return 0;
}

/**
 * Direct HTTP-over-UDS for export. Sends a JSON request body and
 * receives a JSONL response body. Bypasses udsJson because the
 * response isn't a single JSON object.
 */
async function fetchExport(socket: string, body: Record<string, unknown>): Promise<string> {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        path: '/v1/memory/export',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        timeout: 30_000,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString();
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve(buf);
          } else {
            // 4xx/5xx — try to parse as JSON for the error shape.
            try {
              const parsed = JSON.parse(buf);
              const err = parsed?.error ?? `HTTP ${status}`;
              reject(new UdsRequestError(String(err), status, parsed));
            } catch {
              reject(new UdsRequestError(buf || `HTTP ${status}`, status, buf));
            }
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('export request timed out after 30s')));
    req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Import JSONL from stdin (default) or --in <file>. Each non-empty
 * line is parsed as MemoryPutInput on the server side; per-line
 * errors are collected, the run doesn't halt on first failure.
 *
 * Reports `imported: N`; on errors, prints them to stderr (one per
 * line) and exits 1 if any line failed (so scripts can branch on
 * exit code).
 */
async function cmdImport(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
  stderr: (s: string) => void,
): Promise<number> {
  const inFile = stringFlag(parsed.flags, 'in');
  let payload: string;
  if (inFile) {
    payload = await readFile(inFile, 'utf8');
  } else {
    // Read all of stdin synchronously-via-async — for v1 small
    // payloads this is fine; streaming would be a follow-up.
    payload = await readStdin();
  }

  const r = await udsRequest(socket, 'POST', '/v1/memory/import', payload);
  let result: { imported: number; errors: Array<{ line: number; error: string }> };
  try {
    const parsed = JSON.parse(r.body);
    result = parsed.result;
  } catch (err) {
    throw new Error(`import: server returned non-JSON response: ${(err as Error).message}`);
  }

  if (json) {
    stdout(`${JSON.stringify(result)}\n`);
  } else {
    stdout(`imported ${result.imported} entries\n`);
    if (result.errors.length > 0) {
      stdout(`  ${result.errors.length} errors\n`);
      for (const e of result.errors.slice(0, 10)) {
        stderr(`  line ${e.line}: ${e.error}\n`);
      }
      if (result.errors.length > 10) {
        stderr(`  ... and ${result.errors.length - 10} more\n`);
      }
    }
  }
  return result.errors.length > 0 ? 1 : 0;
}

/** Read all of stdin into a string. Used by `import` when no --in flag. */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

/**
 * Read the audit log. Filter flags: --op, --since, --until, --actor,
 * --scope (repeatable), --limit. Output (human): newest first, one
 * line per event with timestamp + op + count + scope summary.
 *
 * Read-only forensic surface — never mutates state. Useful for:
 *   - Debugging "what got deleted yesterday"
 *   - Compliance reports for a user/org scope
 *   - Tracing back from a missing entry to the forget that removed it
 */
async function cmdAudit(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
): Promise<number> {
  const body: Record<string, unknown> = {};
  if (Object.keys(parsed.scope).length > 0) body.scope = parsed.scope;
  const op = stringFlag(parsed.flags, 'op');
  if (op) body.op = op;
  const since = stringFlag(parsed.flags, 'since');
  if (since) body.since = since;
  const until = stringFlag(parsed.flags, 'until');
  if (until) body.until = until;
  const actor = stringFlag(parsed.flags, 'actor');
  if (actor) body.actor = actor;
  const limit = numberFlag(parsed.flags, 'limit');
  if (limit != null) body.limit = limit;

  const r = await udsJson<{ result: { events: AuditEvent[]; count: number } }>(
    socket,
    'POST',
    '/v1/audit',
    body,
  );
  if (json) {
    stdout(`${JSON.stringify(r.body.result)}\n`);
    return 0;
  }
  if (r.body.result.events.length === 0) {
    stdout('(no events)\n');
    return 0;
  }
  const lines: string[] = [];
  for (const ev of r.body.result.events) {
    const scopeBits = ev.scope
      ? Object.entries(ev.scope)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')
      : '';
    lines.push(
      `${ev.timestamp}  ${ev.op.padEnd(7)} ` +
        `count=${ev.count}  ${scopeBits ? `(${scopeBits})  ` : ''}` +
        `actor=${ev.actor}`,
    );
  }
  stdout(`${lines.join('\n')}\n`);
  return 0;
}

async function cmdTag(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
  stderr: (s: string) => void,
): Promise<number> {
  const feedback = stringFlag(parsed.flags, 'feedback');
  if (feedback !== 'positive' && feedback !== 'negative') {
    stderr('error: --feedback positive|negative is required\n');
    return 2;
  }
  const body: Record<string, unknown> = { feedback };
  const entry = parsed.flags.entry;
  if (typeof entry === 'string') body.entryIds = [entry];
  const key = stringFlag(parsed.flags, 'key');
  if (key) body.key = key;
  const olderThan = stringFlag(parsed.flags, 'older-than');
  if (olderThan) body.olderThan = olderThan;
  if (Object.keys(parsed.scope).length > 0) body.scope = parsed.scope;
  const source = stringFlag(parsed.flags, 'source');
  if (source) body.feedbackSource = source;
  if (parsed.flags.overwrite === true) body.overwrite = true;

  const r = await udsJson<Record<string, unknown>>(socket, 'POST', '/v1/memory/tag', body);
  const result = r.body.result as { tagged: number; alreadyTagged: number; taggedIds: string[] };
  if (json) {
    stdout(`${JSON.stringify(result)}\n`);
  } else {
    stdout(
      `tagged ${result.tagged} (already-tagged: ${result.alreadyTagged}) feedback=${feedback}\n`,
    );
  }
  return 0;
}

async function cmdConsolidate(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
  stderr: (s: string) => void,
): Promise<number> {
  const fromRaw = stringFlag(parsed.flags, 'from');
  const toRaw = stringFlag(parsed.flags, 'to');
  if (!fromRaw || !toRaw) {
    stderr('error: --from <scope> and --to <scope> are required (e.g., jobId:j1, productId:web)\n');
    return 2;
  }
  const fromScope = parseScopeFlag(fromRaw);
  const toScope = parseScopeFlag(toRaw);
  if (!fromScope || !toScope) {
    stderr('error: --from / --to must be in <key>:<value> form (e.g., jobId:j1)\n');
    return 2;
  }

  const body: Record<string, unknown> = {
    from: { scope: fromScope },
    to: { scope: toScope },
  };
  const strategy = stringFlag(parsed.flags, 'strategy');
  if (strategy) body.strategy = strategy;
  const topic = stringFlag(parsed.flags, 'topic');
  if (topic) body.topic = topic;
  if (parsed.flags['keep-source'] === true) body.keepSource = true;
  // --feedback-filter accepts comma-separated.
  const filter = stringFlag(parsed.flags, 'feedback-filter');
  if (filter) {
    body.feedbackFilter = filter
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  const r = await udsJson<Record<string, unknown>>(socket, 'POST', '/v1/memory/consolidate', body);
  const result = r.body.result as {
    promoted: number;
    skipped: number;
    summarizedFrom?: number;
    lineageIds: string[];
    feedbackBreakdown: { positive: number; negative: number };
  };
  if (json) {
    stdout(`${JSON.stringify(result)}\n`);
  } else {
    const sum = result.summarizedFrom !== undefined ? ` (from ${result.summarizedFrom})` : '';
    stdout(
      `promoted ${result.promoted}${sum}; skipped ${result.skipped}; ` +
        `+${result.feedbackBreakdown.positive} −${result.feedbackBreakdown.negative}\n`,
    );
  }
  return 0;
}

/** Parse a single --from / --to value of the form "key:value". */
function parseScopeFlag(raw: string): MemoryScope | null {
  const colon = raw.indexOf(':');
  if (colon <= 0) return null;
  const key = raw.slice(0, colon) as keyof MemoryScope;
  const value = raw.slice(colon + 1);
  if (!SCOPE_KEYS.includes(key)) return null;
  return { [key]: value } as MemoryScope;
}

async function cmdCleanup(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
  stderr: (s: string) => void,
): Promise<number> {
  if (Object.keys(parsed.scope).length === 0) {
    stderr('error: --scope is required (e.g., --scope jobId:job_42)\n');
    return 2;
  }
  const r = await udsJson<Record<string, unknown>>(
    socket,
    'POST',
    '/v1/memory/cleanup-unconfirmed',
    {
      scope: parsed.scope,
    },
  );
  const result = r.body.result as { deleted: number; deletedIds: string[] };
  if (json) {
    stdout(`${JSON.stringify(result)}\n`);
  } else {
    stdout(`cleaned up ${result.deleted} unconfirmed entries\n`);
  }
  return 0;
}

async function cmdSnapshot(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
  stderr: (s: string) => void,
): Promise<number> {
  if (Object.keys(parsed.scope).length === 0) {
    stderr('error: --scope is required (e.g., --scope sessionId:abc-123)\n');
    return 2;
  }
  const r = await udsJson<Record<string, unknown>>(socket, 'POST', '/v1/memory/snapshot', {
    scope: parsed.scope,
  });
  const result = r.body.result as { snapshotId: string; count: number; createdAt: string };
  if (json) {
    stdout(`${JSON.stringify(result)}\n`);
  } else {
    stdout(`snapshot ${result.snapshotId} (${result.count} entries) at ${result.createdAt}\n`);
  }
  return 0;
}

async function cmdRestore(
  parsed: ParsedArgs,
  socket: string,
  json: boolean,
  stdout: (s: string) => void,
  stderr: (s: string) => void,
): Promise<number> {
  const snapshotId = stringFlag(parsed.flags, 'snapshot');
  if (!snapshotId) {
    stderr('error: --snapshot <id> is required\n');
    return 2;
  }
  const mode = parsed.flags.merge === true ? 'merge' : 'replace';
  const r = await udsJson<Record<string, unknown>>(socket, 'POST', '/v1/memory/restore', {
    snapshotId,
    mode,
  });
  const result = r.body.result as { restored: number; mode: string; snapshotId: string };
  if (json) {
    stdout(`${JSON.stringify(result)}\n`);
  } else {
    stdout(`restored ${result.restored} entries from ${result.snapshotId} (mode=${result.mode})\n`);
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
        `entries: ${r.body.entryCount ?? 0}\n` +
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

function formatQueryResult(r: MemoryQueryResult): string {
  if (r.kind === 'unsupported') {
    return `unsupported: ${r.reason}\n`;
  }
  if (r.entries.length === 0) {
    return '(no entries)\n';
  }
  const lines: string[] = [];
  for (const e of r.entries) {
    const valueStr = typeof e.value === 'string' ? e.value : JSON.stringify(e.value);
    const snippet = valueStr.length > 80 ? valueStr.slice(0, 80) + '…' : valueStr;
    const scopeBits = Object.entries(e.scope)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    lines.push(`${e.id}  [${e.key}]${scopeBits ? `  (${scopeBits})` : ''}`);
    lines.push(`  ${snippet}`);
    lines.push(`  ${e.createdAt}`);
  }
  return lines.join('\n') + '\n';
}

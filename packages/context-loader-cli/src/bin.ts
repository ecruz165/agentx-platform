#!/usr/bin/env bun
/**
 * agentx-load — CLI for the context loader.
 *
 * Phase F (this file): minimum viable standalone mode. Runs ingest()
 * end-to-end against either Neo4j (bolt://...) or an in-memory backend
 * (for dry-run-style use). Streams IngestionEvents to stdout/stderr
 * based on --output mode. Exits 0 on success, 1 on errors, 2 on bad args.
 *
 * Phase G (next) adds:
 *   - Job mode (--output-events-uds + JOB_ID), so harness-server's
 *     spawnWorker can launch this binary and consume its events
 *   - Workspace-config auto-discovery (read .harness/config/context-sources.yml)
 *
 * Source-type inference is intentionally NOT done — users pass --type
 * explicitly. Auto-detection by file content is a Phase F+ refinement
 * once we have signal beyond extension (e.g., file content sniffing).
 */

import {
  BUILTIN_SOURCE_TYPE_IDS,
  createHttpEmbedderClient,
  type EmbedderClient,
  type GraphIngestionBackend,
  type IngestionEvent,
  InMemoryGraphBackend,
  ingest,
  Neo4jBackend,
} from '@ecruz165/context-loader-core';
import { connectUdsEmitter, type UdsEmitter } from './uds-event-emitter.ts';

// ─── Help / version / types (work without a backend) ──────────────────────

function printUsage(): void {
  process.stdout.write(
    `agentx-load — load context sources into a graph backend.

Usage:
  agentx-load <target> [flags]
  agentx-load types
  agentx-load --help | --version

Primary action — ingest a target:
  agentx-load ./packages/harness-core --type code-full \\
    --backend bolt://localhost:7687 --backend-password devpassword \\
    --embedder-url http://localhost:8080/v1

Required flags:
  --type <id>                  Source type (e.g., 'code-full', 'prose-markdown').
                               See \`agentx-load types\` for the catalog.
  --backend <url>              bolt://host:port  (Neo4j)
                               inmem://          (in-memory; lossy, for dry runs)
  --embedder-url <url>         OpenAI-compatible /v1 endpoint
                               (e.g., http://localhost:8080/v1 with the local
                               ai/qwen3-embedding sidecar; or a Bedrock-fronting
                               proxy in deployed envs).
                               Use 'mock://' for an in-process deterministic
                               embedder when validating flags / dry-running
                               without infrastructure.

Backend auth (Neo4j only):
  --backend-user <user>        defaults to 'neo4j'
  --backend-password <pwd>     required for bolt:// backends; can also come
                               from NEO4J_PASSWORD env var

Embedder options:
  --embedder-model <id>        default: 'ai/qwen3-embedding'
  --embedder-dim <n>           default: 1024

Incremental ingest:
  --force                      Re-ingest every file even if unchanged.
                               Default: files whose content hash matches a
                               prior ingest are skipped (no re-embed).

Output:
  --output json                One IngestionEvent JSON per line on stdout.
  --output progress            Default. Single-line redraw on stderr; final
                               summary JSON on stdout.
  --output silent              Errors only on stderr; final summary on stdout.

Job mode (used by harness-server's spawnWorker; not for direct invocation):
  --output-events-uds <path>   Stream IngestionEvents as JSON-per-line to
                               this Unix domain socket instead of stdout.
                               Requires the JOB_ID env var; every event is
                               tagged with { jobId, ts, ... }.

Catalog:
  agentx-load types            List the built-in source type ids.

See:
  .plans/2026-05-05-prd-context-loader-core.md
  .plans/2026-05-05-prd-context-loader-cli.md
`,
  );
}

function printTypes(): void {
  process.stdout.write(`Built-in source types:\n\n`);
  for (const id of BUILTIN_SOURCE_TYPE_IDS) {
    process.stdout.write(`  - ${id}\n`);
  }
  process.stdout.write(
    `\nThe v1 catalog source-of-truth lives in:\n  packages/context-loader-core/src/catalog/index.ts\n`,
  );
}

function printVersion(): void {
  process.stdout.write(`agentx-load 0.0.0 (Phase F)\n`);
}

// ─── Argv parsing ─────────────────────────────────────────────────────────

interface CliArgs {
  target: string;
  type: string;
  backend: string;
  backendUser: string;
  backendPassword: string | undefined;
  embedderUrl: string;
  embedderModel: string;
  embedderDim: number;
  output: 'json' | 'progress' | 'silent';
  /** Bypass incremental hash-gating; re-ingest every file. */
  force: boolean;
  /** When set, IngestionEvents flow as JSON-per-line to this UDS path
   *  instead of stdout/stderr. Triggered by harness-server's spawnWorker
   *  when running this binary as a job worker. */
  outputEventsUds: string | undefined;
  /** Job id supplied by harness-server via env. Required when outputEventsUds
   *  is set; tagged onto every emitted event. */
  jobId: string | undefined;
}

function parseArgv(argv: string[]): CliArgs {
  // Single positional (target) + flag pairs. Hand-rolled because the
  // surface is small and avoiding a `commander` dep keeps the binary tight.
  let target: string | undefined;
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, vInline] = a.slice(2).split('=', 2);
      if (vInline !== undefined) {
        flags[k!] = vInline;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[k!] = next;
          i++;
        } else {
          flags[k!] = 'true';
        }
      }
    } else if (target === undefined) {
      target = a;
    } else {
      throw new CliError(
        `unexpected positional argument '${a}' (already have target '${target}')`,
        2,
      );
    }
  }
  if (target === undefined) {
    throw new CliError('missing positional target — pass a path to ingest', 2);
  }
  const type = flags.type;
  if (!type) throw new CliError('missing required --type <id>', 2);
  const backend = flags.backend;
  if (!backend) throw new CliError('missing required --backend <url>', 2);
  const embedderUrl = flags['embedder-url'];
  if (!embedderUrl) throw new CliError('missing required --embedder-url <url>', 2);
  const output = (flags.output ?? 'progress') as CliArgs['output'];
  if (output !== 'json' && output !== 'progress' && output !== 'silent') {
    throw new CliError(`--output must be one of: json, progress, silent (got '${output}')`, 2);
  }
  const dimStr = flags['embedder-dim'] ?? '1024';
  const dim = Number(dimStr);
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new CliError(`--embedder-dim must be a positive integer (got '${dimStr}')`, 2);
  }
  const outputEventsUds = flags['output-events-uds'];
  const jobId = process.env.JOB_ID;
  if (outputEventsUds && !jobId) {
    throw new CliError(
      "--output-events-uds requires the JOB_ID env var (set by harness-server's spawnWorker)",
      2,
    );
  }
  return {
    target,
    type,
    backend,
    backendUser: flags['backend-user'] ?? 'neo4j',
    backendPassword: flags['backend-password'] ?? process.env.NEO4J_PASSWORD,
    embedderUrl,
    embedderModel: flags['embedder-model'] ?? 'ai/qwen3-embedding',
    embedderDim: dim,
    output,
    force: flags.force === 'true',
    outputEventsUds,
    jobId,
  };
}

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

// ─── Backend construction ─────────────────────────────────────────────────

async function buildBackend(args: CliArgs): Promise<GraphIngestionBackend> {
  if (args.backend.startsWith('inmem')) {
    return new InMemoryGraphBackend();
  }
  if (
    args.backend.startsWith('bolt://') ||
    args.backend.startsWith('neo4j://') ||
    args.backend.startsWith('neo4j+s://') ||
    args.backend.startsWith('neo4j+ssc://')
  ) {
    if (!args.backendPassword) {
      throw new CliError('bolt:// backend requires --backend-password (or NEO4J_PASSWORD env)', 2);
    }
    return new Neo4jBackend({
      url: args.backend,
      user: args.backendUser,
      password: args.backendPassword,
      vectorDim: args.embedderDim,
    });
  }
  throw new CliError(
    `unsupported backend URL scheme: '${args.backend}' (expected bolt://, neo4j://, neo4j+s://, neo4j+ssc://, or inmem://)`,
    2,
  );
}

// ─── Output renderers ─────────────────────────────────────────────────────

interface ProgressState {
  itemsWalked: number;
  itemsSkipped: number;
  chunksProduced: number;
  nodesWritten: number;
  edgesWritten: number;
  vectorsWritten: number;
  errors: number;
  lastItem: string;
}

/** Render a single-line stderr progress redraw. Cheap and friendly for
 *  interactive use; pipes capture stdout cleanly because we keep this on stderr. */
function renderProgress(state: ProgressState): void {
  const line =
    `files=${state.itemsWalked} skipped=${state.itemsSkipped} chunks=${state.chunksProduced} ` +
    `nodes=${state.nodesWritten} edges=${state.edgesWritten} ` +
    `vectors=${state.vectorsWritten} errors=${state.errors}` +
    (state.lastItem ? `  ${truncMiddle(state.lastItem, 40)}` : '');
  process.stderr.write(`\r\x1b[K${line}`);
}

function truncMiddle(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const half = Math.floor((maxLen - 3) / 2);
  return `${s.slice(0, half)}...${s.slice(s.length - half)}`;
}

function makeEventHandler(args: CliArgs): {
  onEvent: (e: IngestionEvent) => void;
  finalize: () => void;
} {
  const state: ProgressState = {
    itemsWalked: 0,
    itemsSkipped: 0,
    chunksProduced: 0,
    nodesWritten: 0,
    edgesWritten: 0,
    vectorsWritten: 0,
    errors: 0,
    lastItem: '',
  };
  return {
    onEvent: (e) => {
      switch (e.kind) {
        case 'item-walked':
          state.itemsWalked++;
          state.lastItem = e.itemId;
          break;
        case 'item-unchanged':
          state.itemsSkipped++;
          state.lastItem = e.itemId;
          break;
        case 'chunk-produced':
          state.chunksProduced += e.chunkCount;
          break;
        case 'node-written':
          state.nodesWritten++;
          break;
        case 'edge-written':
          state.edgesWritten++;
          break;
        case 'chunk-embedded':
          state.vectorsWritten++;
          break;
        case 'error':
          state.errors++;
          process.stderr.write(
            `\nerror at ${e.phase}${e.item ? ` (${e.item})` : ''}: ${e.message}\n`,
          );
          break;
        case 'source-completed':
          // Final summary handled separately below; nothing to do here.
          break;
      }
      if (args.output === 'json') {
        process.stdout.write(`${JSON.stringify(e)}\n`);
      } else if (args.output === 'progress') {
        renderProgress(state);
      }
      // 'silent': no output here; only errors flushed via stderr above.
    },
    finalize: () => {
      if (args.output === 'progress') {
        // Clear the progress line + newline so the summary lands cleanly.
        process.stderr.write(`\r\x1b[K`);
      }
    },
  };
}

// ─── Main ingest flow ─────────────────────────────────────────────────────

/** Deterministic in-process embedder for `--embedder-url mock://`. Useful
 *  when validating chunker/dispatch end-to-end without standing up the
 *  embedder service — the produced vectors are correct-shape but
 *  semantically meaningless, so don't use this against a real backend
 *  that anyone will query. */
function buildMockEmbedder(dim: number): EmbedderClient {
  let counter = 0;
  return {
    dim,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => {
        counter++;
        const v = new Float32Array(dim);
        for (let i = 0; i < dim; i++) v[i] = (counter * (i + 1)) % 7;
        return v;
      });
    },
  };
}

async function runIngest(args: CliArgs): Promise<number> {
  const backend = await buildBackend(args);
  const embedderClient: EmbedderClient = args.embedderUrl.startsWith('mock')
    ? buildMockEmbedder(args.embedderDim)
    : createHttpEmbedderClient({
        config: {
          url: args.embedderUrl,
          model: args.embedderModel,
          dim: args.embedderDim,
        },
      });

  // Job mode: events flow over the UDS instead of stdout/stderr. The
  // standalone progress/json/silent renderers are only used when there's
  // no UDS to write to.
  let udsEmitter: UdsEmitter | null = null;
  if (args.outputEventsUds && args.jobId) {
    udsEmitter = await connectUdsEmitter({
      socketPath: args.outputEventsUds,
      jobId: args.jobId,
    });
  }
  // Output composition: when UDS is configured, we still want the
  // standalone renderer if the user explicitly asked for `--output
  // progress` or `--output json`. The "dual" mode (UDS + stdout) is
  // exactly what the tmux-pane setup uses — UDS feeds JobBus + the
  // jobs-tui dashboard while the pane shows the live progress bar.
  // Default behavior unchanged: --output silent (or no flag) under UDS
  // produces no stdout — same as before this change.
  const useStandalone = !udsEmitter || args.output === 'progress' || args.output === 'json';
  const standalone = useStandalone ? makeEventHandler(args) : null;

  // SIGTERM in job mode: write a `cancelled` event and exit within 5s.
  // The AbortSignal we pass into ingest() lets the loader bail out
  // cooperatively at the next walk-step boundary.
  const abortController = new AbortController();
  const sigtermHandler = (): void => {
    abortController.abort();
    udsEmitter?.emitMeta('cancelled', { reason: 'sigterm' });
    // Hard cap at 5s; the abort should let the current step return,
    // but if it hangs on I/O we don't want to wedge the worker forever.
    setTimeout(() => process.exit(143), 5000).unref();
  };
  process.on('SIGTERM', sigtermHandler);

  try {
    const summary = await ingest({
      source: { type: args.type, ref: { kind: 'path', path: args.target } },
      backend,
      embedderClient,
      force: args.force,
      onEvent: (e) => {
        // Fire BOTH outputs when both are enabled (tmux-pane mode).
        if (udsEmitter) udsEmitter.emit(e);
        if (standalone) standalone.onEvent(e);
      },
      signal: abortController.signal,
    });
    standalone?.finalize();
    if (!udsEmitter || args.output !== 'silent') {
      // Standalone, or UDS+progress/json: print the summary so a tmux
      // pane has something to show after the bar finishes redrawing.
      // Only suppress when explicitly silent under UDS (the original
      // pure worker-container behavior — empty stdout on success).
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    }
    return summary.errors > 0 ? 1 : 0;
  } finally {
    process.removeListener('SIGTERM', sigtermHandler);
    await udsEmitter?.close().catch(() => {});
    await backend.close().catch(() => {
      // Don't mask the original error if close also fails.
    });
  }
}

// ─── Entry ────────────────────────────────────────────────────────────────

const [first, ...rest] = process.argv.slice(2);

if (!first || first === '--help' || first === '-h') {
  printUsage();
  process.exit(0);
}
if (first === '--version' || first === '-v') {
  printVersion();
  process.exit(0);
}
if (first === 'types' && rest.length === 0) {
  printTypes();
  process.exit(0);
}

// Everything else is the primary action: <target> [flags]. Even if first
// is one of the legacy verbs (`add`, `list`, etc.), we don't recognize
// them — Phase F drops the verb-required surface in favor of positional
// target. Users get a clean error pointing at --help.
try {
  const args = parseArgv(process.argv.slice(2));
  const code = await runIngest(args);
  process.exit(code);
} catch (err) {
  if (err instanceof CliError) {
    process.stderr.write(`agentx-load: ${err.message}\n\n`);
    if (err.exitCode === 2) printUsage();
    process.exit(err.exitCode);
  }
  process.stderr.write(`agentx-load: unexpected error: ${(err as Error).message}\n`);
  if (process.env.DEBUG) {
    process.stderr.write(`${(err as Error).stack ?? ''}\n`);
  }
  process.exit(1);
}

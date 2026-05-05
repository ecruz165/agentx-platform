/**
 * Loader-job spawn primitive.
 *
 * This is the harness-server side of the wire-format contract documented
 * in `prd-context-loader-cli.md` §9. It:
 *
 *   1. Allocates a per-job UDS path under `.harness/run/`
 *   2. Listens on it for newline-delimited JSON
 *   3. Spawns `agentx-load` as a child process with --output-events-uds
 *      pointing at that path + JOB_ID in env
 *   4. Fans inbound events out to subscribers
 *   5. Resolves a completion promise when the child exits cleanly or
 *      rejects with a meaningful error when it doesn't
 *
 * Lives separately from `spawn-worker.ts` (the devcontainer-spawn agent
 * worker primitive) because loaders don't need git worktrees, per-job
 * branches, or devcontainer-cli — they just need a child process and an
 * event channel. Adopting the heavier path comes when loaders run inside
 * dedicated workspace-isolated containers (Phase H+ or ECS path).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, unlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Public types ──────────────────────────────────────────────────────────

export interface LoaderSpawnSpec {
  /** Job identifier — surfaces on every emitted event and on the UDS path. */
  jobId: string;
  /** Path to ingest (passed as positional to agentx-load). */
  target: string;
  /** Source type id (e.g., 'code-full', 'prose-markdown'). */
  type: string;
  /** Backend URL: `bolt://...`, `neo4j://...`, `inmem://`. */
  backend: string;
  backendUser?: string;
  backendPassword?: string;
  embedderUrl: string;
  embedderModel?: string;
  embedderDim?: number;
  /** Output mode the worker should use. Defaults to 'silent' since events
   *  flow over the UDS, not stdout. */
  output?: 'json' | 'progress' | 'silent';
  /** Workspace root — UDS path is allocated under `<root>/.harness/run/`. */
  workspaceRoot: string;
  /** Override for the agentx-load executable. Defaults to the bin.ts under
   *  packages/context-loader-cli (dev mode). Production builds set this to
   *  the path of the bundled binary. */
  agentxLoadCommand?: { command: string; prefixArgs?: string[] };
  /**
   * When set, spawn the loader inside its own tmux pane in this session +
   * window so each concurrent loader has a dedicated pane for raw stdout
   * + the live `--output progress` bar. The window is created lazily if
   * absent. The parent doesn't track the child process directly — instead,
   * `whenComplete` resolves on the `source-completed` UDS event and rejects
   * on a heartbeat-based timeout if no events arrive for `tmuxIdleTimeoutMs`.
   *
   * Local-dev only: tmux is not available on ECS Fargate or in CI, so set
   * this only when `process.env.TMUX` is present.
   */
  tmuxPane?: {
    /** tmux session name, e.g. 'agentx'. */
    session: string;
    /** Window name within the session. Created if missing. */
    window: string;
  };
  /** When tmux mode is on, reject `whenComplete` if no UDS events arrive
   *  for this long (default 60_000ms) — a proxy for "the child crashed
   *  inside the pane and we'll never see source-completed." */
  tmuxIdleTimeoutMs?: number;
}

/** A single event that came off the UDS, including the wrapper fields the
 *  CLI adds (`jobId`, `ts`). The inner shape is `IngestionEvent` from
 *  context-loader-core; see prd-context-loader-cli §9 for canonical
 *  structure. */
export interface LoaderEvent {
  jobId: string;
  ts: number;
  kind: string;
  // Other fields are kind-dependent; we don't narrow here because consumers
  // typically just forward to a TUI / SSE / log sink.
  [key: string]: unknown;
}

export interface LoaderJobHandle {
  readonly jobId: string;
  /** Attach a subscriber. Returns an unsubscribe. */
  subscribe(handler: (event: LoaderEvent) => void): () => void;
  /** Resolves with the final source-completed event when the child exits
   *  cleanly. Rejects if the child exits non-zero, dies before emitting
   *  source-completed, or fails to start. */
  whenComplete: Promise<LoaderEvent>;
  /** Send SIGTERM to the loader. The CLI's signal handler emits a
   *  `cancelled` event and exits within 5s. */
  cancel(): void;
}

// ─── Internals ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Default location of agentx-load's bin.ts in the dev-tree. Resolves
 *  relative to this file's location so it works under both ts-node and
 *  bun. Production builds inject `agentxLoadCommand` to point at a
 *  bundled binary instead. */
function defaultAgentxLoadCommand(): { command: string; prefixArgs: string[] } {
  // packages/harness-server/src → packages/context-loader-cli/src/bin.ts
  const binPath = join(__dirname, '..', '..', 'context-loader-cli', 'src', 'bin.ts');
  return { command: 'bun', prefixArgs: [binPath] };
}

function buildArgs(spec: LoaderSpawnSpec, udsPath: string): string[] {
  const args: string[] = [
    spec.target,
    '--type', spec.type,
    '--backend', spec.backend,
    '--embedder-url', spec.embedderUrl,
    '--output-events-uds', udsPath,
    '--output', spec.output ?? 'silent',
  ];
  if (spec.backendUser) args.push('--backend-user', spec.backendUser);
  if (spec.backendPassword) args.push('--backend-password', spec.backendPassword);
  if (spec.embedderModel) args.push('--embedder-model', spec.embedderModel);
  if (spec.embedderDim !== undefined) {
    args.push('--embedder-dim', String(spec.embedderDim));
  }
  return args;
}

// ─── Main entrypoint ───────────────────────────────────────────────────────

/** macOS caps Unix socket paths at 104 bytes; Linux is 108. We pick the
 *  smaller for portability. Going over silently breaks: listen() succeeds
 *  but child processes can't connect. Detect early so the error mentions
 *  the actual constraint instead of "ENOENT". */
const UDS_PATH_MAX = 104;

export async function spawnLoaderJob(spec: LoaderSpawnSpec): Promise<LoaderJobHandle> {
  const runDir = join(spec.workspaceRoot, '.harness', 'run');
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const udsPath = join(runDir, `loader-${spec.jobId}.sock`);
  if (udsPath.length >= UDS_PATH_MAX) {
    throw new Error(
      `loader UDS path exceeds ${UDS_PATH_MAX}-byte OS limit (${udsPath.length} bytes): ${udsPath}. ` +
        `Use a shorter workspaceRoot or jobId — Unix sockets cannot be created at long paths.`
    );
  }
  // Best-effort cleanup of any stale socket from a crashed prior run.
  await unlink(udsPath).catch(() => {});

  const subscribers = new Set<(event: LoaderEvent) => void>();
  const events: LoaderEvent[] = [];
  let lastError: Error | null = null;

  // The first connection wins: we expect exactly one writer (the spawned
  // loader). Additional connections would mean a misconfiguration and are
  // closed immediately.
  let writerConnected = false;

  const server: Server = createServer((sock) => {
    if (writerConnected) {
      sock.destroy();
      return;
    }
    writerConnected = true;

    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as LoaderEvent;
          events.push(event);
          for (const handler of subscribers) {
            try {
              handler(event);
            } catch {
              // Isolated — one bad consumer can't break delivery to others
              // or block the producer.
            }
          }
        } catch (err) {
          lastError = err as Error;
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(udsPath, () => resolve());
  });

  // We pass JOB_ID so the CLI's argv-parsing path is satisfied — it
  // rejects --output-events-uds without it.
  const cmd = spec.agentxLoadCommand ?? defaultAgentxLoadCommand();
  const childArgs = [...(cmd.prefixArgs ?? []), ...buildArgs(spec, udsPath)];
  const childEnv = { ...process.env, JOB_ID: spec.jobId };

  // Two spawn paths:
  //   - tmux mode: spawn the loader inside a dedicated pane. The parent
  //     process doesn't track child exit (tmux-cli exits immediately
  //     after creating the pane). Completion is detected via the UDS
  //     `source-completed` event; failure via an idle timeout.
  //   - direct mode: child_process.spawn the loader, capture stderr,
  //     resolve/reject on child exit. Original v1 behavior.
  if (spec.tmuxPane) {
    return setupTmuxLoader({
      spec,
      cmd: cmd.command,
      args: childArgs,
      env: childEnv,
      udsPath,
      server,
      subscribers,
      events,
      lastError: () => lastError,
    });
  }

  const child: ChildProcess = spawn(cmd.command, childArgs, {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Capture stderr for diagnostics. stdout should be empty in --output silent
  // mode, but we drain it anyway to avoid backpressure.
  let stderr = '';
  child.stderr?.on('data', (c) => (stderr += c.toString()));
  child.stdout?.on('data', () => {
    /* drained */
  });

  const whenComplete: Promise<LoaderEvent> = new Promise((resolve, reject) => {
    child.on('exit', async (code, signal) => {
      // Drain anything still on the wire, close the server.
      await new Promise<void>((res) => server.close(() => res()));
      await unlink(udsPath).catch(() => {});

      const completion = events.find((e) => e.kind === 'source-completed');
      if (code === 0 && completion) {
        resolve(completion);
        return;
      }
      const detail =
        stderr.trim() || (lastError ? `JSON parse: ${lastError.message}` : '');
      const reason =
        signal !== null
          ? `killed by ${signal}`
          : code !== 0
            ? `exit code ${code}`
            : 'no source-completed event';
      reject(
        new Error(
          `loader job ${spec.jobId} failed: ${reason}${detail ? ` — ${detail}` : ''}`
        )
      );
    });
    child.on('error', (err) => {
      reject(err);
    });
  });

  return {
    jobId: spec.jobId,
    subscribe(handler) {
      subscribers.add(handler);
      // Replay events that arrived before this subscriber attached so it
      // doesn't miss the early lifecycle markers (the source-resolved
      // event in particular).
      for (const e of events) {
        try {
          handler(e);
        } catch {
          /* isolated */
        }
      }
      return () => subscribers.delete(handler);
    },
    whenComplete,
    cancel() {
      child.kill('SIGTERM');
    },
  };
}

/** tmux-mode spawn: shell out to `tmux split-window` so the loader runs
 *  inside a dedicated pane with its own scrollback + visible progress
 *  bar. Returns a handle whose whenComplete resolves on the UDS
 *  `source-completed` event and rejects on idle timeout. The pane
 *  outlives the parent; user can `tmux kill-pane` interactively or
 *  through harness-cli's cancel(). */
function setupTmuxLoader(deps: {
  spec: LoaderSpawnSpec;
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  udsPath: string;
  server: Server;
  subscribers: Set<(event: LoaderEvent) => void>;
  events: LoaderEvent[];
  lastError: () => Error | null;
}): LoaderJobHandle {
  const { spec, cmd, args, env, udsPath, server, subscribers, events, lastError } = deps;
  const pane = spec.tmuxPane!;
  const idleTimeoutMs = spec.tmuxIdleTimeoutMs ?? 60_000;
  let paneId: string | null = null;

  // Lazy-create the window if missing. `tmux has-session` + `new-window`
  // are idempotent enough for our purposes; if the user-named session
  // doesn't exist, the whole tmux path fails fast.
  try {
    spawn('tmux', ['has-session', '-t', pane.session], { stdio: 'ignore' });
    // Create the target window if absent (best-effort; ignore "duplicate window" errors).
    const ensureWindow = spawn(
      'tmux',
      ['new-window', '-d', '-t', `${pane.session}:`, '-n', pane.window],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    // Drain to avoid backpressure; we don't care about the result.
    ensureWindow.stdout?.on('data', () => {});
    ensureWindow.stderr?.on('data', () => {});
  } catch {
    // tmux not on PATH — caller should detect this before opting in.
  }

  // Build the shell-quoted command for tmux to run inside the pane.
  // We use the array form rather than shell concatenation to avoid
  // injection from spec values (workspaceRoot, target paths, etc.).
  // tmux's `split-window` accepts a single command string after `--`,
  // so we shell-quote each token manually.
  const quoted = [cmd, ...args].map(shellQuote).join(' ');
  // Inject the JOB_ID into the pane's env via a leading `JOB_ID=… exec`.
  // Each pane is a fresh shell, so process.env from the parent doesn't carry.
  const fullCommand = `JOB_ID=${shellQuote(spec.jobId)} exec ${quoted}`;

  // `-P -F '#{pane_id}'` returns the new pane id on stdout so we can
  // target it for cancel() later.
  const tmuxArgs = [
    'split-window',
    '-d',
    '-t',
    `${pane.session}:${pane.window}`,
    '-P',
    '-F',
    '#{pane_id}',
    fullCommand,
  ];
  const tmuxProc = spawn('tmux', tmuxArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let tmuxOut = '';
  let tmuxErr = '';
  tmuxProc.stdout?.on('data', (c) => (tmuxOut += c.toString()));
  tmuxProc.stderr?.on('data', (c) => (tmuxErr += c.toString()));

  const whenComplete: Promise<LoaderEvent> = new Promise((resolve, reject) => {
    let resolved = false;
    const finish = (fn: () => void): void => {
      if (resolved) return;
      resolved = true;
      fn();
    };
    const cleanup = async (): Promise<void> => {
      await new Promise<void>((res) => server.close(() => res()));
      await unlink(udsPath).catch(() => {});
    };

    tmuxProc.on('exit', (code) => {
      if (code === 0) {
        // Tag the pane with the jobId so `harness attach <jobId>` can
        // resolve it later. `select-pane -T` sets the pane title; that's
        // what `list-panes -F '#{pane_title}'` returns.
        const id = tmuxOut.trim();
        if (id) {
          const tag = spawn(
            'tmux',
            ['select-pane', '-t', id, '-T', `load-${spec.jobId}`],
            { stdio: 'ignore' }
          );
          tag.on('error', () => {
            /* tmux may have died between split + select; harmless */
          });
        }
      }
      if (code !== 0) {
        finish(() => {
          void cleanup();
          reject(
            new Error(
              `loader job ${spec.jobId}: tmux split-window failed (exit ${code}) — ${tmuxErr.trim() || 'no stderr'}`
            )
          );
        });
      } else {
        paneId = tmuxOut.trim();
      }
    });

    // Re-arm an idle timer on every event. If no events arrive for
    // idleTimeoutMs, treat it as a crashed loader and reject.
    let idleTimer: NodeJS.Timeout = setTimeout(onIdle, idleTimeoutMs);
    function onIdle(): void {
      finish(() => {
        void cleanup();
        const detail = lastError() ? `JSON parse: ${lastError()!.message}` : '';
        reject(
          new Error(
            `loader job ${spec.jobId}: no UDS events for ${idleTimeoutMs}ms — pane likely crashed${detail ? ` — ${detail}` : ''}`
          )
        );
      });
    }

    // Attach a passthrough subscriber that watches for source-completed
    // and resets the idle timer on every event. Adding it via
    // `subscribers.add` instead of through the public subscribe() so it
    // doesn't appear in the subscriber count and never gets removed
    // before completion.
    const watchHandler = (event: LoaderEvent): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdle, idleTimeoutMs);
      if (event.kind === 'source-completed') {
        clearTimeout(idleTimer);
        finish(() => {
          void cleanup();
          resolve(event);
        });
      }
    };
    subscribers.add(watchHandler);
  });

  return {
    jobId: spec.jobId,
    subscribe(handler) {
      subscribers.add(handler);
      for (const e of events) {
        try {
          handler(e);
        } catch {
          /* isolated */
        }
      }
      return () => subscribers.delete(handler);
    },
    whenComplete,
    cancel() {
      // Send SIGTERM to the pane's foreground process. tmux 3.0+ has
      // `send-keys -l` for literal text, but the simpler approach is
      // `kill-pane` — the loader's SIGTERM handler will fire on the
      // pane being torn down because tmux sends SIGHUP to the child.
      if (paneId) {
        spawn('tmux', ['kill-pane', '-t', paneId], { stdio: 'ignore' });
      }
    },
  };
}

/** Conservative shell-quoter for tmux's `command` argument. tmux uses
 *  the first non-option argument as a shell command-line that gets
 *  passed to /bin/sh -c, so single-quoting (with embedded-quote escape)
 *  is the simplest safe path. */
function shellQuote(s: string): string {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_./:=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

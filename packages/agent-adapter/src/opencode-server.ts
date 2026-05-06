/**
 * OpenCodeServer — lifecycle wrapper around `opencode serve`.
 *
 * Two modes:
 *
 * 1. **Direct mode** (default): spawn `opencode serve` directly via the
 *    injected spawnFn (defaults to node:child_process.spawn). Read stderr
 *    for the "listening on" log line, kill via SIGTERM. Used by tests
 *    and any caller that doesn't need tmux peek-ability.
 *
 * 2. **Tmux mode** (when `tmuxSocket` is set): spawn `opencode serve`
 *    inside a detached tmux session via `tmux new-session -d`, with
 *    output tee'd to a logfile (`<workspace>/.harness/run/jobs/<jobId>/
 *    opencode-server.log` or wherever the caller specifies). Detection
 *    polls the logfile for "listening on". Kill via `tmux kill-session`.
 *    Per memory `project_pipeline_tmux_topology` — devs can attach to the
 *    session via `tmux -S <socket> attach -t opencode-server -r` and
 *    watch the live log stream.
 *
 * Spawn safety: argv array form, no shell unless using tmux mode (where
 * we deliberately compose a shell command for tee). Tmux command and
 * arguments are constructed from controlled inputs only — no user input
 * flows in unescaped.
 */

import { spawn as defaultSpawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Spawn function signature, compatible with node:child_process spawn(). */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; stdio?: ['ignore', 'pipe', 'pipe'] }
) => ChildProcess;

export interface OpenCodeServerOptions {
  /** Path to the opencode binary. Default: `opencode` (PATH lookup). */
  bin?: string;
  /** Port to listen on. Default: random in 30000-39999. */
  port?: number;
  /** Hostname to bind. Default: '127.0.0.1'. */
  hostname?: string;
  /** Pass `--pure` (run without external plugins). Default: true. */
  pure?: boolean;
  /** Startup timeout in ms before failing with "did not log listening".
   *  Default: 30s. */
  startupTimeoutMs?: number;
  /** Extra env vars merged into the child process env. */
  env?: NodeJS.ProcessEnv;
  /** Forward server stdout/stderr to this process's stderr after startup.
   *  Default: false. Direct mode only — has no effect in tmux mode. */
  forwardLogs?: boolean;
  /** Inject a spawn function. Default: node:child_process.spawn. */
  spawnFn?: SpawnFn;

  /** Tmux socket path. When set, the server is spawned inside a tmux
   *  session (detached) on this socket, and detection polls the logfile
   *  instead of reading the child's stderr directly. Per memory
   *  `project_pipeline_tmux_topology`. */
  tmuxSocket?: string;
  /** Tmux session name. Default: 'opencode-server'. Tmux-mode only. */
  tmuxSessionName?: string;
  /** Logfile path used for tee'd output in tmux mode. Default: a temp
   *  file beside the tmux socket. Tmux-mode only. */
  logPath?: string;
  /** Polling interval for the logfile in tmux mode. Default: 100ms. */
  pollIntervalMs?: number;
}

export interface OpenCodeServerHandle {
  url: string;
  port: number;
}

export class OpenCodeServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenCodeServerError';
  }
}

const LISTENING_RE = /opencode server listening on (\S+)/;

export class OpenCodeServer {
  private child: ChildProcess | null = null;
  private handle: OpenCodeServerHandle | null = null;
  private tmuxState: { socket: string; session: string; logPath: string; spawnFn: SpawnFn } | null = null;

  get url(): string | null {
    return this.handle?.url ?? null;
  }

  /** Start the server. Returns once "listening on" is detected. */
  async start(opts: OpenCodeServerOptions = {}): Promise<OpenCodeServerHandle> {
    if (this.child || this.tmuxState) {
      throw new OpenCodeServerError('OpenCodeServer.start() called twice on the same instance');
    }
    const port = opts.port ?? randomPort();
    const hostname = opts.hostname ?? '127.0.0.1';
    const bin = opts.bin ?? 'opencode';
    const pure = opts.pure !== false;

    if (opts.tmuxSocket) {
      return await this.startInTmux({ ...opts, port, hostname, bin, pure });
    }
    return await this.startDirect({ ...opts, port, hostname, bin, pure });
  }

  /** Direct-spawn mode: original behavior, reads stderr for detection. */
  private async startDirect(opts: {
    bin: string; port: number; hostname: string; pure: boolean;
    startupTimeoutMs?: number; env?: NodeJS.ProcessEnv; forwardLogs?: boolean;
    spawnFn?: SpawnFn;
  }): Promise<OpenCodeServerHandle> {
    const { bin, port, hostname, pure, startupTimeoutMs = 30_000, env, forwardLogs, spawnFn } = opts;
    const args = ['serve', '--port', String(port), '--hostname', hostname, '--print-logs'];
    if (pure) args.push('--pure');

    const fn = spawnFn ?? (defaultSpawn as SpawnFn);
    const child = fn(bin, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    return new Promise<OpenCodeServerHandle>((resolve, reject) => {
      const buffer: string[] = [];
      const tail = (max = 600): string => {
        const all = buffer.join('');
        return all.length > max ? '…' + all.slice(-max) : all;
      };

      const cleanupListeners = () => {
        clearTimeout(timeoutHandle);
        child.stdout?.off('data', onData);
        child.stderr?.off('data', onData);
        child.off('error', onError);
        child.off('exit', onExit);
      };
      const succeed = (url: string) => {
        cleanupListeners();
        this.handle = { url, port };
        if (forwardLogs) {
          child.stdout?.on('data', (c: Buffer) => process.stderr.write(c));
          child.stderr?.on('data', (c: Buffer) => process.stderr.write(c));
        }
        resolve(this.handle);
      };
      const fail = (msg: string) => {
        cleanupListeners();
        try { child.kill('SIGTERM'); } catch { /* best effort */ }
        this.child = null;
        reject(new OpenCodeServerError(msg));
      };

      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        buffer.push(text);
        const m = LISTENING_RE.exec(text) ?? LISTENING_RE.exec(buffer.join(''));
        if (m) succeed(m[1]!);
      };
      const onError = (err: Error) => fail(`opencode spawn error: ${err.message}`);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        const why = code !== null ? `exited with code ${code}` : `killed by signal ${signal}`;
        fail(`opencode serve ${why} before logging "listening". Tail: ${tail()}`);
      };
      const timeoutHandle = setTimeout(() => {
        fail(`opencode serve did not log "listening" within ${startupTimeoutMs}ms. Tail: ${tail()}`);
      }, startupTimeoutMs);

      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', onError);
      child.on('exit', onExit);
    });
  }

  /** Tmux mode: spawn inside detached session, tee output to logfile,
   *  poll the logfile for the listening line. Per memory
   *  `project_pipeline_tmux_topology` — the session is attachable via
   *  `tmux -S <socket> attach -t <session> -r`. */
  private async startInTmux(opts: {
    bin: string; port: number; hostname: string; pure: boolean;
    startupTimeoutMs?: number; env?: NodeJS.ProcessEnv;
    spawnFn?: SpawnFn;
    tmuxSocket?: string; tmuxSessionName?: string; logPath?: string;
    pollIntervalMs?: number;
  }): Promise<OpenCodeServerHandle> {
    const {
      bin, port, hostname, pure,
      startupTimeoutMs = 30_000,
      tmuxSocket, tmuxSessionName = 'opencode-server',
      logPath: logPathOpt, pollIntervalMs = 100,
      env, spawnFn,
    } = opts;
    if (!tmuxSocket) throw new OpenCodeServerError('startInTmux called without tmuxSocket');
    const fn = spawnFn ?? (defaultSpawn as SpawnFn);
    const logPath = logPathOpt ?? `${dirname(tmuxSocket)}/${tmuxSessionName}.log`;

    // Ensure the parent directory exists for both the socket and log.
    // Don't pre-create the logfile itself — `tee` inside the session
    // creates it on first write. (And if a caller pre-populated the
    // file for a test, truncating here would wipe the seeded content.)
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });

    // Build the inner shell command. Quoting is controlled — no user input.
    // 2>&1 routes stderr into the same stream; tee mirrors to logfile while
    // the tmux pane displays the live output for `tmux attach -r`.
    const innerCmd = [
      shellQuote(bin), 'serve',
      '--port', String(port),
      '--hostname', shellQuote(hostname),
      '--print-logs',
      ...(pure ? ['--pure'] : []),
      '2>&1', '|', 'tee', shellQuote(logPath),
    ].join(' ');

    // Create the detached session running our inner command. tmux's
    // new-session resolves immediately; the inner shell continues
    // independently inside the session.
    const tmuxArgs = [
      '-S', tmuxSocket,
      'new-session', '-d',
      '-s', tmuxSessionName,
      'sh', '-c', innerCmd,
    ];
    await runProc(fn, 'tmux', tmuxArgs, env);

    this.tmuxState = { socket: tmuxSocket, session: tmuxSessionName, logPath, spawnFn: fn };

    // Poll the logfile for the "listening" line. 100ms default cadence is
    // fine for a process that boots in ~1s; a too-fast poll would burn CPU
    // for no benefit.
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      // First check: did the session die already? If so, the inner process
      // crashed before we could detect listening — fail with the log tail.
      const alive = await tmuxHasSession(fn, tmuxSocket, tmuxSessionName, env);
      const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
      const m = LISTENING_RE.exec(log);
      if (m) {
        this.handle = { url: m[1]!, port };
        return this.handle;
      }
      if (!alive) {
        await this.killTmux();
        throw new OpenCodeServerError(
          `opencode serve session ended before logging "listening". Tail: ${tailString(log)}`
        );
      }
      await sleep(pollIntervalMs);
    }
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    await this.killTmux();
    throw new OpenCodeServerError(
      `opencode serve did not log "listening" within ${startupTimeoutMs}ms. Tail: ${tailString(log)}`
    );
  }

  /** SIGTERM the server, then SIGKILL after grace. Idempotent. In tmux
   *  mode, runs `tmux kill-session` instead. */
  async kill(graceMs = 5000): Promise<void> {
    if (this.tmuxState) {
      await this.killTmux();
      this.handle = null;
      return;
    }
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.handle = null;
    try { child.kill('SIGTERM'); } catch { /* may already be dead */ }
    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => { if (!settled) { settled = true; resolve(); } };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* best effort */ }
        settle();
      }, graceMs);
      child.on('exit', () => { clearTimeout(timer); settle(); });
    });
  }

  private async killTmux(): Promise<void> {
    const state = this.tmuxState;
    if (!state) return;
    this.tmuxState = null;
    try {
      await runProc(state.spawnFn, 'tmux', ['-S', state.socket, 'kill-session', '-t', state.session]);
    } catch { /* session may be gone already */ }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

function randomPort(): number {
  return 30_000 + Math.floor(Math.random() * 10_000);
}

/** Run a process to completion, capturing exit code. Throws on non-zero. */
function runProc(
  fn: SpawnFn,
  cmd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = fn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new OpenCodeServerError(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}

/** Returns true iff `tmux has-session -t <name>` reports the session. */
function tmuxHasSession(
  fn: SpawnFn,
  socket: string,
  session: string,
  env?: NodeJS.ProcessEnv
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = fn('tmux', ['-S', socket, 'has-session', '-t', session], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tailString(s: string, max = 600): string {
  return s.length > max ? '…' + s.slice(-max) : s;
}

/** Single-quote shell-escape — wrap in single quotes, escape any embedded
 *  single quotes via `'\''`. Inputs are controlled (binary path, hostname,
 *  port string, log path) but explicit escaping is cheap insurance. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

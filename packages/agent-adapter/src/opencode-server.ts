/**
 * OpenCodeServer — lifecycle wrapper around `opencode serve`.
 *
 * Per memory `feedback_opencode_http_mode`: the OpenCode CLI must run as a
 * long-lived HTTP server, not a per-invoke subprocess. This class is the
 * v1 cut: spawn `opencode serve` once on `start()`, capture its listening
 * URL from stdout, expose it for adapters to attach to via `opencode run
 * --attach`, kill on `kill()`.
 *
 * Per memory `project_proxy_per_job_architecture`: each per-job
 * harness-pipeline container owns ONE OpenCodeServer instance, shared by
 * all OpenCode-bound adapters in that job. Container lifecycle = server
 * lifecycle.
 *
 * Per memory `project_pipeline_tmux_topology`: the harness-pipeline level
 * wraps OpenCodeServer.start() inside a tmux session for developer
 * peek-ability. This file stays tmux-agnostic — accepts an optional
 * `spawnFn` so callers can plug in a tmux-spawning function without
 * coupling this primitive to deployment shape.
 *
 * Spawn safety: uses node:child_process spawn() with an argv array, never
 * a shell string — no command injection surface.
 */

import { spawn as defaultSpawn, type ChildProcess } from 'node:child_process';

/** Spawn function signature, compatible with node:child_process spawn().
 *  Exposed as an injection point for tmux wrapping (slice 9c) and for
 *  unit tests that need a controllable mock. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; stdio?: ['ignore', 'pipe', 'pipe'] }
) => ChildProcess;

export interface OpenCodeServerOptions {
  /** Path to the opencode binary. Default: `opencode` (PATH lookup). */
  bin?: string;
  /** Port to listen on. Default: a random port in 30000-39999 to avoid
   *  collisions with the opencode CLI's default 4096. */
  port?: number;
  /** Hostname to bind. Default: '127.0.0.1' (loopback only). */
  hostname?: string;
  /** Pass `--pure` (run without external plugins). Default: true. */
  pure?: boolean;
  /** How long to wait for the "listening on" log line before giving up.
   *  Default: 30s. */
  startupTimeoutMs?: number;
  /** Extra env vars merged into the child process env. */
  env?: NodeJS.ProcessEnv;
  /** When true, captured server stdout/stderr is forwarded to this
   *  process's stderr after startup completes. Default: false. */
  forwardLogs?: boolean;
  /** Inject a spawn function. Default: node:child_process spawn(). The
   *  harness-pipeline runtime overrides this to wrap in tmux; tests
   *  override it for controllable mocks. */
  spawnFn?: SpawnFn;
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

  /** Returns the listening URL after start() resolves; null otherwise. */
  get url(): string | null {
    return this.handle?.url ?? null;
  }

  /** Spawn `opencode serve` and resolve once the server logs that it's
   *  listening. Throws OpenCodeServerError on timeout, spawn error, or
   *  early exit. */
  async start(opts: OpenCodeServerOptions = {}): Promise<OpenCodeServerHandle> {
    if (this.child) {
      throw new OpenCodeServerError('OpenCodeServer.start() called twice on the same instance');
    }
    const port = opts.port ?? randomPort();
    const hostname = opts.hostname ?? '127.0.0.1';
    const startupTimeoutMs = opts.startupTimeoutMs ?? 30_000;
    const args = [
      'serve',
      '--port', String(port),
      '--hostname', hostname,
      '--print-logs',
    ];
    if (opts.pure !== false) args.push('--pure');

    const spawnFn = opts.spawnFn ?? defaultSpawn;
    const child = spawnFn(opts.bin ?? 'opencode', args, {
      env: { ...process.env, ...opts.env },
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
        if (opts.forwardLogs) {
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

  /** SIGTERM the server, then SIGKILL after grace. Idempotent. */
  async kill(graceMs = 5000): Promise<void> {
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
}

function randomPort(): number {
  return 30_000 + Math.floor(Math.random() * 10_000);
}

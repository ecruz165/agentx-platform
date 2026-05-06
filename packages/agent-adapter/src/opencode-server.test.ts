/**
 * OpenCodeServer lifecycle tests.
 *
 * Uses spawnFn dependency injection (the constructor option introduced for
 * exactly this purpose) to feed a controllable fake child process — no
 * vi.mock needed, no real opencode binary needed. Stable across vitest
 * versions and bun runtime quirks.
 *
 * Real-binary integration coverage lives behind RUN_OPENCODE_INTEGRATION=1.
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeServer, OpenCodeServerError, type SpawnFn } from './opencode-server.ts';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

/** Build a SpawnFn that returns the given fake child + records its calls. */
function makeSpawnFn(child: FakeChild): {
  fn: SpawnFn;
  calls: Array<{ cmd: string; args: readonly string[] }>;
} {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const fn: SpawnFn = (cmd, args) => {
    calls.push({ cmd, args });
    // The cast is safe — FakeChild has the EventEmitter surface +
    // stdout/stderr/kill that OpenCodeServer consumes, which is the
    // contract subset of node:child_process ChildProcess we depend on.
    return child as unknown as ReturnType<SpawnFn>;
  };
  return { fn, calls };
}

describe('OpenCodeServer (unit, injected spawnFn)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the URL when the listening log line arrives on stderr', async () => {
    const child = fakeChild();
    const { fn, calls } = makeSpawnFn(child);
    const server = new OpenCodeServer();

    const startPromise = server.start({ port: 31337, spawnFn: fn });
    setImmediate(() => {
      child.stderr.emit(
        'data',
        Buffer.from('opencode server listening on http://127.0.0.1:31337\n'),
      );
    });
    const handle = await startPromise;
    expect(handle.url).toBe('http://127.0.0.1:31337');
    expect(handle.port).toBe(31337);
    expect(server.url).toBe('http://127.0.0.1:31337');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('opencode');
    expect(calls[0]!.args).toContain('serve');
    expect(calls[0]!.args).toContain('--port');
    expect(calls[0]!.args).toContain('31337');
  });

  it('resolves when the log line comes on stdout instead of stderr', async () => {
    const child = fakeChild();
    const { fn } = makeSpawnFn(child);
    const server = new OpenCodeServer();

    const startPromise = server.start({ port: 31338, spawnFn: fn });
    setImmediate(() => {
      child.stdout.emit(
        'data',
        Buffer.from('opencode server listening on http://127.0.0.1:31338\n'),
      );
    });
    const handle = await startPromise;
    expect(handle.port).toBe(31338);
  });

  it('passes --pure by default and --hostname 127.0.0.1', async () => {
    const child = fakeChild();
    const { fn, calls } = makeSpawnFn(child);
    const server = new OpenCodeServer();

    const startPromise = server.start({ port: 31339, spawnFn: fn });
    setImmediate(() => {
      child.stderr.emit(
        'data',
        Buffer.from('opencode server listening on http://127.0.0.1:31339\n'),
      );
    });
    await startPromise;

    expect(calls[0]!.args).toContain('--pure');
    expect(calls[0]!.args).toContain('--hostname');
    expect(calls[0]!.args).toContain('127.0.0.1');
  });

  it('omits --pure when pure: false', async () => {
    const child = fakeChild();
    const { fn, calls } = makeSpawnFn(child);
    const server = new OpenCodeServer();

    const startPromise = server.start({ port: 31340, pure: false, spawnFn: fn });
    setImmediate(() => {
      child.stderr.emit(
        'data',
        Buffer.from('opencode server listening on http://127.0.0.1:31340\n'),
      );
    });
    await startPromise;

    expect(calls[0]!.args).not.toContain('--pure');
  });

  it('throws if start() is called twice on the same instance', async () => {
    const child = fakeChild();
    const { fn } = makeSpawnFn(child);
    const server = new OpenCodeServer();

    void server.start({ spawnFn: fn });
    await expect(server.start({ spawnFn: fn })).rejects.toThrow(/start\(\) called twice/);
  });

  it('throws OpenCodeServerError when the process exits before listening', async () => {
    const child = fakeChild();
    const { fn } = makeSpawnFn(child);
    const server = new OpenCodeServer();

    const startPromise = server.start({ port: 31341, startupTimeoutMs: 5000, spawnFn: fn });
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('error: bind failed\n'));
      child.emit('exit', 1, null);
    });
    await expect(startPromise).rejects.toThrow(OpenCodeServerError);
    await expect(startPromise).rejects.toThrow(/exited with code 1/);
  });

  it('throws OpenCodeServerError when startup times out', async () => {
    const child = fakeChild();
    const { fn } = makeSpawnFn(child);
    const server = new OpenCodeServer();

    // Tiny timeout, child never logs "listening" — timeout fires
    await expect(server.start({ startupTimeoutMs: 50, spawnFn: fn })).rejects.toThrow(
      /did not log "listening" within 50ms/,
    );
  });

  it('kill() SIGTERMs the process and resolves on exit', async () => {
    const child = fakeChild();
    const { fn } = makeSpawnFn(child);
    const server = new OpenCodeServer();

    const startPromise = server.start({ port: 31342, spawnFn: fn });
    setImmediate(() => {
      child.stderr.emit(
        'data',
        Buffer.from('opencode server listening on http://127.0.0.1:31342\n'),
      );
    });
    await startPromise;

    const killPromise = server.kill(50);
    setImmediate(() => child.emit('exit', 0, 'SIGTERM'));
    await killPromise;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(server.url).toBeNull();
  });

  it('kill() is idempotent (safe to call before start or twice)', async () => {
    const server = new OpenCodeServer();

    await server.kill();
    await server.kill();
    expect(server.url).toBeNull();
  });

  it('escalates to SIGKILL after grace period if SIGTERM ignored', async () => {
    const child = fakeChild();
    const { fn } = makeSpawnFn(child);
    const server = new OpenCodeServer();

    const startPromise = server.start({ port: 31343, spawnFn: fn });
    setImmediate(() => {
      child.stderr.emit(
        'data',
        Buffer.from('opencode server listening on http://127.0.0.1:31343\n'),
      );
    });
    await startPromise;

    // Don't emit exit — process is "stuck" — kill() should escalate after grace
    await server.kill(20);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

describe('OpenCodeServer (tmux mode, injected spawnFn)', () => {
  it('passes tmux args (new-session -d -s) and returns URL when logfile contains listening line', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'opencode-tmux-'));
    const logPath = join(tmpDir, 'opencode-server.log');
    const socketPath = join(tmpDir, 'tmux.sock');

    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    let hasSessionResponse = true;
    const fn: SpawnFn = (cmd, args) => {
      calls.push({ cmd, args });
      const child = fakeChild();
      // tmux invocations exit immediately. has-session signals existence
      // via exit code (0 = exists). We simulate "session is alive" by
      // exiting 0; "session is gone" by exiting 1.
      const isHasSession = args.includes('has-session');
      setImmediate(() => {
        if (isHasSession) {
          child.emit('exit', hasSessionResponse ? 0 : 1, null);
        } else {
          child.emit('exit', 0, null);
        }
      });
      return child as unknown as ReturnType<SpawnFn>;
    };

    // Pre-populate the logfile with the listening line — the polling loop
    // should detect it on its first read and resolve.
    writeFileSync(logPath, 'opencode server listening on http://127.0.0.1:31337\n');

    const server = new OpenCodeServer();
    try {
      const handle = await server.start({
        spawnFn: fn,
        tmuxSocket: socketPath,
        tmuxSessionName: 'opencode-server',
        logPath,
        port: 31337,
        pollIntervalMs: 10,
        startupTimeoutMs: 5000,
      });
      expect(handle.url).toBe('http://127.0.0.1:31337');
      // First call should be the new-session
      expect(calls[0]!.cmd).toBe('tmux');
      expect(calls[0]!.args).toContain('-S');
      expect(calls[0]!.args).toContain(socketPath);
      expect(calls[0]!.args).toContain('new-session');
      expect(calls[0]!.args).toContain('-d');
      expect(calls[0]!.args).toContain('-s');
      expect(calls[0]!.args).toContain('opencode-server');
    } finally {
      hasSessionResponse = false; // simulate session-already-killed during teardown
      await server.kill();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails when tmux session ends before listening line is written', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'opencode-tmux-fail-'));
    const logPath = join(tmpDir, 'opencode-server.log');
    const socketPath = join(tmpDir, 'tmux.sock');

    const hasSessionResponse = false; // session "doesn't exist" — simulating crash
    const fn: SpawnFn = (_cmd, args) => {
      const child = fakeChild();
      const isHasSession = args.includes('has-session');
      setImmediate(() => {
        if (isHasSession) {
          child.emit('exit', hasSessionResponse ? 0 : 1, null);
        } else {
          child.emit('exit', 0, null);
        }
      });
      return child as unknown as ReturnType<SpawnFn>;
    };

    // Logfile populated with an error message but no listening line
    writeFileSync(logPath, 'error: bind failed; port already in use\n');

    const server = new OpenCodeServer();
    try {
      await expect(
        server.start({
          spawnFn: fn,
          tmuxSocket: socketPath,
          logPath,
          port: 31338,
          pollIntervalMs: 10,
          startupTimeoutMs: 1000,
        }),
      ).rejects.toThrow(/session ended before logging "listening"/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('kill() in tmux mode runs tmux kill-session', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'opencode-tmux-kill-'));
    const logPath = join(tmpDir, 'opencode-server.log');
    const socketPath = join(tmpDir, 'tmux.sock');

    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const fn: SpawnFn = (cmd, args) => {
      calls.push({ cmd, args });
      const child = fakeChild();
      setImmediate(() => {
        // has-session reports alive (exit 0) so polling resolves, then
        // kill-session always returns 0 too
        child.emit('exit', 0, null);
      });
      return child as unknown as ReturnType<SpawnFn>;
    };
    writeFileSync(logPath, 'opencode server listening on http://127.0.0.1:31339\n');

    const server = new OpenCodeServer();
    await server.start({
      spawnFn: fn,
      tmuxSocket: socketPath,
      tmuxSessionName: 'opencode-server',
      logPath,
      port: 31339,
      pollIntervalMs: 10,
    });
    await server.kill();

    const killCall = calls.find((c) => c.args.includes('kill-session'));
    expect(killCall).toBeDefined();
    expect(killCall!.args).toContain('opencode-server');
    expect(server.url).toBeNull();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// Real-binary integration test — only runs when explicitly enabled.
const RUN_OPENCODE = process.env.RUN_OPENCODE_INTEGRATION === '1';
const integration = RUN_OPENCODE ? describe : describe.skip;

integration('OpenCodeServer (integration, real opencode binary)', () => {
  it('starts a real opencode serve, returns its URL, kills it cleanly', async () => {
    const server = new OpenCodeServer();
    try {
      const handle = await server.start({ startupTimeoutMs: 15_000 });
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await server.kill();
    }
  }, 30_000);
});

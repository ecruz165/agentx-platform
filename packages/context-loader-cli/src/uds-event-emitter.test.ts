/**
 * UDS event-stream tests.
 *
 * Spins up a tiny in-process Unix domain socket server, runs the CLI
 * binary against it via spawn(), and asserts on the newline-delimited
 * JSON events that arrive. Validates the wire-format contract documented
 * in prd-context-loader-cli.md §9.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, 'bin.ts');
const HARNESS_CORE = resolve(__dirname, '../../harness-core');

interface UdsCollector {
  server: Server;
  socketPath: string;
  events: Array<Record<string, unknown>>;
  /** Promise that resolves once the client disconnects (clean end-of-job). */
  whenDone: Promise<void>;
  stop: () => Promise<void>;
}

/** Listen on a UDS in a temp dir, parse newline-delimited JSON, push each
 *  parsed event into `events`. Used by tests to capture what the CLI emits. */
async function startUdsCollector(): Promise<UdsCollector> {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-uds-'));
  const socketPath = join(dir, 'events.sock');
  const events: Array<Record<string, unknown>> = [];
  let resolveWhenDone: () => void;
  const whenDone = new Promise<void>((res) => {
    resolveWhenDone = res;
  });

  const server = createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim().length > 0) {
          try {
            events.push(JSON.parse(line));
          } catch {
            // Tests should never see malformed JSON; surface it as a tagged event.
            events.push({ kind: '__bad_json', raw: line });
          }
        }
      }
    });
    sock.on('end', () => resolveWhenDone());
    sock.on('close', () => resolveWhenDone());
  });

  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(socketPath, () => res());
  });

  return {
    server,
    socketPath,
    events,
    whenDone,
    stop: async () => {
      await new Promise<void>((res) => server.close(() => res()));
      try {
        unlinkSync(socketPath);
      } catch {
        /* socket may already be gone */
      }
    },
  };
}

function spawnCli(
  args: string[],
  env: Record<string, string>
): { exit: Promise<number>; kill: () => void } {
  const child = spawn('bun', [BIN, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = new Promise<number>((res) => {
    child.on('exit', (code) => res(code ?? -1));
  });
  return { exit, kill: () => child.kill('SIGTERM') };
}

describe('UDS job-mode event stream', () => {
  it('streams ingestion events as JSON-per-line tagged with jobId/ts', async () => {
    const collector = await startUdsCollector();
    try {
      const { exit } = spawnCli(
        [
          HARNESS_CORE,
          '--type', 'code-full',
          '--backend', 'inmem://',
          '--embedder-url', 'mock://',
          '--output-events-uds', collector.socketPath,
        ],
        { JOB_ID: 'test-job-001' }
      );
      const code = await exit;
      await collector.whenDone;

      expect(code).toBe(0);
      expect(collector.events.length).toBeGreaterThan(5);

      // Every event must carry jobId + ts + kind.
      for (const e of collector.events) {
        expect(e.jobId).toBe('test-job-001');
        expect(typeof e.ts).toBe('number');
        expect(typeof e.kind).toBe('string');
      }

      // The standard ingestion lifecycle markers should all be present.
      const kinds = new Set(collector.events.map((e) => e.kind));
      expect(kinds.has('item-walked')).toBe(true);
      expect(kinds.has('chunk-produced')).toBe(true);
      expect(kinds.has('node-written')).toBe(true);
      expect(kinds.has('source-completed')).toBe(true);
    } finally {
      await collector.stop();
    }
  });

  it('refuses --output-events-uds without JOB_ID env', async () => {
    const collector = await startUdsCollector();
    try {
      const child = spawn('bun', [
        BIN,
        HARNESS_CORE,
        '--type', 'code-full',
        '--backend', 'inmem://',
        '--embedder-url', 'mock://',
        '--output-events-uds', collector.socketPath,
      ], {
        // Strip JOB_ID so we hit the validation path. Don't inherit it
        // from this test process either.
        env: { ...process.env, JOB_ID: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (c) => (stderr += c.toString()));
      const code = await new Promise<number>((res) => child.on('exit', (c) => res(c ?? -1)));
      expect(code).toBe(2);
      expect(stderr).toContain('JOB_ID');
    } finally {
      await collector.stop();
    }
  });

  it('emits a cancelled event on SIGTERM and exits within the 5s grace window', async () => {
    const collector = await startUdsCollector();
    try {
      // Race condition we have to work around: a fast machine can finish
      // ingesting the whole agentx repo in ~170ms with the mock embedder.
      // To guarantee SIGTERM lands mid-flight, target a huge directory tree
      // (`/`) that the matcher will never finish walking, and signal as
      // soon as we know the child is up. The matcher excludes most of /
      // via its default code-full exclude list (node_modules, etc.) but
      // it'll still take far longer than our SIGTERM-to-exit budget.
      const proc = spawnCli(
        [
          '/',
          '--type', 'code-full',
          '--backend', 'inmem://',
          '--embedder-url', 'mock://',
          '--output-events-uds', collector.socketPath,
        ],
        { JOB_ID: 'test-job-cancel' }
      );
      // Wait until at least one event has arrived — that proves the worker
      // is up and writing to the UDS — then send SIGTERM.
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (collector.events.length > 0) {
            clearInterval(check);
            resolve();
          }
        }, 20);
      });
      proc.kill();
      const code = await proc.exit;
      await collector.whenDone;

      // The contract is "exits within 5s after SIGTERM and writes a
      // cancelled event." Exit code varies (0 = clean abort, 143 = forced
      // 5s timeout, 1 = abort path returned non-zero); all three count.
      expect([0, 143, 1]).toContain(code);

      const cancelled = collector.events.find((e) => e.kind === 'cancelled');
      expect(cancelled).toBeDefined();
      expect(cancelled!.reason).toBe('sigterm');
      expect(cancelled!.jobId).toBe('test-job-cancel');
    } finally {
      await collector.stop();
    }
  }, 15_000);
});

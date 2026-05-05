/**
 * Integration tests for `spawnLoaderJob`.
 *
 * Exercises the full G.2 path: harness-server spawns agentx-load as a
 * child, listens on a UDS, parses newline-delimited JSON, and fans events
 * out to subscribers. No real backend or embedder needed (uses inmem://
 * + mock://).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { spawnLoaderJob, type LoaderEvent } from './loader-spawn.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_CORE = resolve(__dirname, '../../harness-core');

let workspaceRoot: string;

beforeEach(() => {
  // Use /tmp directly (not os.tmpdir() / mkdtempSync of the standard
  // location) because macOS resolves os.tmpdir() to a deep /var/folders/
  // path that pushes the resulting UDS over the 104-byte sun_path limit.
  // listen() succeeds at long paths but connect() fails with ENOENT, so
  // we have to keep it short.
  workspaceRoot = mkdtempSync('/tmp/agx-test-');
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('spawnLoaderJob', () => {
  it('spawns agentx-load, streams events, and resolves on completion', async () => {
    const handle = await spawnLoaderJob({
      jobId: 'job-001',
      target: HARNESS_CORE,
      type: 'code-full',
      backend: 'inmem://',
      embedderUrl: 'mock://',
      embedderDim: 8,
      workspaceRoot,
    });

    const collected: LoaderEvent[] = [];
    handle.subscribe((e) => collected.push(e));

    const completion = await handle.whenComplete;

    // The completion event is the source-completed wrapper from the CLI.
    expect(completion.kind).toBe('source-completed');
    expect(completion.jobId).toBe('job-001');
    expect(typeof completion.ts).toBe('number');

    // Lifecycle markers should all be in the collected stream.
    const kinds = new Set(collected.map((e) => e.kind));
    expect(kinds.has('item-walked')).toBe(true);
    expect(kinds.has('chunk-produced')).toBe(true);
    expect(kinds.has('node-written')).toBe(true);
    expect(kinds.has('source-completed')).toBe(true);

    // Every event carries the wrapper fields.
    for (const e of collected) {
      expect(e.jobId).toBe('job-001');
      expect(typeof e.ts).toBe('number');
      expect(typeof e.kind).toBe('string');
    }
  }, 15_000);

  it('replays buffered events to a late subscriber', async () => {
    const handle = await spawnLoaderJob({
      jobId: 'job-002',
      target: HARNESS_CORE,
      type: 'code-full',
      backend: 'inmem://',
      embedderUrl: 'mock://',
      embedderDim: 8,
      workspaceRoot,
    });

    // Wait for completion *before* subscribing — exercises the replay path.
    await handle.whenComplete;

    const collected: LoaderEvent[] = [];
    handle.subscribe((e) => collected.push(e));

    // Late subscriber still sees the full lifecycle that already played out.
    const kinds = new Set(collected.map((e) => e.kind));
    expect(kinds.has('item-walked')).toBe(true);
    expect(kinds.has('source-completed')).toBe(true);
  }, 15_000);

  it('rejects whenComplete when the loader fails to start', async () => {
    // Point at an invalid backend scheme — the CLI's argv-parsing path
    // exits with code 2 before it ever connects to the UDS.
    const handle = await spawnLoaderJob({
      jobId: 'job-fail',
      target: HARNESS_CORE,
      type: 'code-full',
      backend: 'unknown://wat',
      embedderUrl: 'mock://',
      embedderDim: 8,
      workspaceRoot,
    });
    await expect(handle.whenComplete).rejects.toThrow(/loader job job-fail failed/);
  }, 15_000);

  it('cancel() sends SIGTERM and surfaces a cancelled event', async () => {
    // Walking `/` is effectively unbounded under the code-full matcher's
    // exclude rules — any sane SIGTERM lands mid-walk.
    const handle = await spawnLoaderJob({
      jobId: 'job-cancel',
      target: '/',
      type: 'code-full',
      backend: 'inmem://',
      embedderUrl: 'mock://',
      embedderDim: 8,
      workspaceRoot,
    });

    const collected: LoaderEvent[] = [];
    handle.subscribe((e) => collected.push(e));

    // Wait for the first event to confirm the worker is up, then cancel.
    await new Promise<void>((res) => {
      const check = setInterval(() => {
        if (collected.length > 0) {
          clearInterval(check);
          res();
        }
      }, 20);
    });
    handle.cancel();

    // The cancel triggers the CLI to exit non-zero (no source-completed),
    // so whenComplete rejects. We don't care about the specific exit code,
    // just that a `cancelled` event landed in the stream.
    await handle.whenComplete.catch(() => {});

    const cancelled = collected.find((e) => e.kind === 'cancelled');
    expect(cancelled).toBeDefined();
    expect(cancelled!.reason).toBe('sigterm');
  }, 15_000);
});

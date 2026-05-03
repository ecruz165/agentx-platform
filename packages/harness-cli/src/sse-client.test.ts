import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startHarnessServer, type Envelope, type HarnessServerHandle } from '@agentx/harness-server';
import { connectSseStream } from './sse-client.ts';

// macOS AF_UNIX sun_path is 104 chars — keep this short.
const tmpSocket = () => join(tmpdir(), `ax-${randomUUID().slice(0, 8)}.sock`);

describe('connectSseStream', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  const start = async (): Promise<HarnessServerHandle & { socketPath: string }> => {
    const socketPath = tmpSocket();
    const handle = await startHarnessServer({ socketPath });
    cleanups.push(async () => {
      await handle.stop();
      await rm(socketPath, { force: true });
    });
    return Object.assign(handle, { socketPath });
  };

  const waitFor = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
  };

  it('receives envelopes published onto the bus', async () => {
    const handle = await start();
    const seen: Envelope[] = [];

    const close = connectSseStream<Envelope>(
      handle.socketPath,
      '/v1/jobs/job-1/events',
      (e) => seen.push(e)
    );

    // Wait for the server to register the subscription before publishing.
    await waitFor(() => handle.bus.subscriberCount('job-1') === 1);

    handle.bus.publish('job-1', 'planner', {
      kind: 'request',
      ts: 't1',
      user: 'plan it',
      model: 'm',
    });
    handle.bus.publish('job-1', 'planner', {
      kind: 'response',
      ts: 't2',
      text: 'plan: do x',
    });

    await waitFor(() => seen.length === 2);

    expect(seen[0]).toMatchObject({ jobId: 'job-1', agentId: 'planner' });
    expect(seen[0]?.event.kind).toBe('request');
    expect(seen[1]?.event.kind).toBe('response');

    close();
  });

  it('close() unsubscribes on the server side', async () => {
    const handle = await start();
    const close = connectSseStream<Envelope>(
      handle.socketPath,
      '/v1/jobs/job-1/events',
      () => {}
    );

    await waitFor(() => handle.bus.subscriberCount('job-1') === 1);
    expect(handle.bus.subscriberCount('job-1')).toBe(1);

    close();

    await waitFor(() => handle.bus.subscriberCount('job-1') === 0);
    expect(handle.bus.subscriberCount('job-1')).toBe(0);
  });

  it('ignores non-data SSE lines (heartbeats / connect comments)', async () => {
    const handle = await start();
    const seen: Envelope[] = [];

    const close = connectSseStream<Envelope>(
      handle.socketPath,
      '/v1/jobs/job-1/events',
      (e) => seen.push(e)
    );

    await waitFor(() => handle.bus.subscriberCount('job-1') === 1);

    // The server writes `: connected\n\n` immediately on connect — the client
    // must not invoke onEvent for it.
    expect(seen).toHaveLength(0);

    close();
  });
});

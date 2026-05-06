import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Envelope } from '@agentx/harness-core';
import { afterEach, describe, expect, it } from 'vitest';
import { type HarnessServerHandle, startHarnessServer } from './index.ts';

// macOS AF_UNIX sun_path is 104 chars — keep this short.
const tmpSocket = () => join(tmpdir(), `ax-${randomUUID().slice(0, 8)}.sock`);

interface SseClient {
  envelopes: Promise<Envelope[]>;
  abort: () => void;
}

/**
 * Minimal SSE-over-UDS client. Resolves to all `data:` frames received before
 * the server closes the response. Caller can `abort()` to disconnect early.
 */
function connectSse(
  socketPath: string,
  urlPath: string,
  expectN: number,
  timeoutMs = 2_000,
): SseClient {
  const envelopes: Envelope[] = [];
  let abort = () => {};

  const promise = new Promise<Envelope[]>((resolve, reject) => {
    const req = request({ socketPath, path: urlPath, method: 'GET' }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE returned ${res.statusCode}`));
        return;
      }
      let buffer = '';
      const onData = (chunk: Buffer | string) => {
        buffer += chunk.toString();
        while (true) {
          const idx = buffer.indexOf('\n\n');
          if (idx < 0) break;
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                envelopes.push(JSON.parse(line.slice(6)) as Envelope);
              } catch {
                // ignore malformed frame in test
              }
            }
          }
          if (envelopes.length >= expectN) {
            req.destroy();
            resolve(envelopes);
            return;
          }
        }
      };
      res.on('data', onData);
      res.on('end', () => resolve(envelopes));
      res.on('error', reject);
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      // ECONNRESET on req.destroy() is expected after we hit expectN.
      if (err.code === 'ECONNRESET' && envelopes.length >= expectN) {
        resolve(envelopes);
      } else {
        reject(err);
      }
    });
    req.end();

    abort = () => {
      req.destroy();
      resolve(envelopes);
    };

    setTimeout(() => {
      req.destroy();
      reject(
        new Error(`SSE timed out after ${timeoutMs}ms (received ${envelopes.length}/${expectN})`),
      );
    }, timeoutMs);
  });

  return { envelopes: promise, abort };
}

describe('GET /v1/jobs/:id/events (SSE-over-UDS)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
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

  it('streams envelopes published onto the bus to a connected client', async () => {
    const handle = await start();
    const sse = connectSse(handle.socketPath, '/v1/jobs/job-1/events', 2);

    // Give the server time to register the subscription.
    await new Promise((r) => setTimeout(r, 50));

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

    const envelopes = await sse.envelopes;

    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]).toMatchObject({ jobId: 'job-1', agentId: 'planner' });
    expect(envelopes[0]?.event.kind).toBe('request');
    expect(envelopes[1]?.event.kind).toBe('response');
  });

  it('does not deliver events from other jobs', async () => {
    const handle = await start();
    const sse = connectSse(handle.socketPath, '/v1/jobs/job-A/events', 1, 1_000);

    await new Promise((r) => setTimeout(r, 50));

    handle.bus.publish('job-B', 'agent-x', {
      kind: 'request',
      ts: 't1',
      user: 'wrong job',
      model: 'm',
    });
    handle.bus.publish('job-A', 'agent-y', {
      kind: 'request',
      ts: 't2',
      user: 'right job',
      model: 'm',
    });

    const envelopes = await sse.envelopes;

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.jobId).toBe('job-A');
    expect((envelopes[0]?.event as { user: string }).user).toBe('right job');
  });

  it('unsubscribes when the client disconnects', async () => {
    const handle = await start();
    const sse = connectSse(handle.socketPath, '/v1/jobs/job-1/events', 99, 1_500);

    // Wait for the subscription to register.
    await waitFor(() => handle.bus.subscriberCount('job-1') === 1, 500);
    expect(handle.bus.subscriberCount('job-1')).toBe(1);

    sse.abort();

    // After the client closes, the server should clean up its subscription.
    await waitFor(() => handle.bus.subscriberCount('job-1') === 0, 500);
    expect(handle.bus.subscriberCount('job-1')).toBe(0);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Unit tests for the shared JSONL-stream consumer (slice 9d-3).
 *
 * Uses node:stream PassThrough to feed bytes into the parser without
 * spawning a real subprocess — the parser doesn't care where the
 * stream comes from, so this is the cleanest way to exercise its
 * parsing semantics + tail capture + sentinel detection.
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  JobBus,
  type Envelope,
} from '@agentx/harness-core';
import { consumeJsonlStream } from './pipeline-jsonl-stream.ts';

function makeStreams() {
  return { stdout: new PassThrough(), stderr: new PassThrough() };
}

function envelope(jobId: string, agentId: string, text: string): Envelope {
  return {
    jobId,
    agentId,
    event: { kind: 'response', ts: '2026-01-01T00:00:00Z', text },
  };
}

describe('consumeJsonlStream', () => {
  it('republishes envelopes on the JobBus', async () => {
    const { stdout, stderr } = makeStreams();
    const bus = new JobBus();
    const seen: Envelope[] = [];
    bus.subscribe('j1', (env) => seen.push(env));

    const promise = consumeJsonlStream({ stdout, stderr, bus, expectedJobId: 'j1' });

    stdout.write(JSON.stringify(envelope('j1', 'planner', 'hello')) + '\n');
    stdout.write(JSON.stringify(envelope('j1', 'planner', 'world')) + '\n');
    stdout.end();
    stderr.end();

    const result = await promise;
    expect(seen).toHaveLength(2);
    expect(result.sentinel).toBeUndefined();
  });

  it('detects the job-complete sentinel', async () => {
    const { stdout, stderr } = makeStreams();
    const bus = new JobBus();
    const promise = consumeJsonlStream({ stdout, stderr, bus, expectedJobId: 'j1' });

    stdout.write(
      JSON.stringify({ kind: 'job-complete', jobId: 'j1', status: 'completed' }) + '\n'
    );
    stdout.end();
    stderr.end();

    const result = await promise;
    expect(result.sentinel).toEqual({
      kind: 'job-complete',
      jobId: 'j1',
      status: 'completed',
    });
  });

  it('handles partial chunks split across data events (boundary case)', async () => {
    const { stdout, stderr } = makeStreams();
    const bus = new JobBus();
    const seen: Envelope[] = [];
    bus.subscribe('j1', (env) => seen.push(env));

    const promise = consumeJsonlStream({ stdout, stderr, bus, expectedJobId: 'j1' });

    const env = JSON.stringify(envelope('j1', 'a', 'split me'));
    // Split the JSON string mid-byte across multiple data events.
    stdout.write(env.slice(0, 10));
    stdout.write(env.slice(10, 20));
    stdout.write(env.slice(20) + '\n');
    stdout.end();
    stderr.end();

    await promise;
    expect(seen).toHaveLength(1);
    if (seen[0]?.event.kind === 'response') {
      expect(seen[0].event.text).toBe('split me');
    }
  });

  it('handles multiple JSON objects in a single chunk', async () => {
    const { stdout, stderr } = makeStreams();
    const bus = new JobBus();
    const seen: Envelope[] = [];
    bus.subscribe('j1', (env) => seen.push(env));

    const promise = consumeJsonlStream({ stdout, stderr, bus, expectedJobId: 'j1' });

    stdout.write(
      JSON.stringify(envelope('j1', 'a', 'one')) + '\n' +
      JSON.stringify(envelope('j1', 'a', 'two')) + '\n' +
      JSON.stringify(envelope('j1', 'a', 'three')) + '\n'
    );
    stdout.end();
    stderr.end();

    await promise;
    expect(seen).toHaveLength(3);
  });

  it('skips non-JSON lines without crashing', async () => {
    const { stdout, stderr } = makeStreams();
    const bus = new JobBus();
    const seen: Envelope[] = [];
    bus.subscribe('j1', (env) => seen.push(env));

    const promise = consumeJsonlStream({ stdout, stderr, bus, expectedJobId: 'j1' });

    stdout.write('this is not JSON\n');
    stdout.write(JSON.stringify(envelope('j1', 'a', 'real')) + '\n');
    stdout.write('garbage line again\n');
    stdout.end();
    stderr.end();

    await promise;
    // Only the real envelope made it through.
    expect(seen).toHaveLength(1);
  });

  it('drops envelopes whose jobId mismatches the expected one (defensive)', async () => {
    const { stdout, stderr } = makeStreams();
    const bus = new JobBus();
    const seen: Envelope[] = [];
    bus.subscribe('j1', (env) => seen.push(env));
    bus.subscribe('j2-poison', (env) => seen.push(env));

    const promise = consumeJsonlStream({ stdout, stderr, bus, expectedJobId: 'j1' });

    stdout.write(JSON.stringify(envelope('j2-poison', 'a', 'should-drop')) + '\n');
    stdout.write(JSON.stringify(envelope('j1', 'a', 'should-keep')) + '\n');
    stdout.end();
    stderr.end();

    await promise;
    expect(seen).toHaveLength(1);
    if (seen[0]?.event.kind === 'response') {
      expect(seen[0].event.text).toBe('should-keep');
    }
  });

  it('captures stderr tail capped at 4 KiB', async () => {
    const { stdout, stderr } = makeStreams();
    const bus = new JobBus();
    const promise = consumeJsonlStream({ stdout, stderr, bus, expectedJobId: 'j1' });

    // Write 5 KiB of stderr; expect last 4 KiB returned.
    const blob = 'x'.repeat(5000);
    stderr.write(blob);
    stdout.end();
    stderr.end();

    const result = await promise;
    expect(result.stderrTail.length).toBe(4096);
    expect(result.stderrTail).toBe('x'.repeat(4096));
  });

  it('drops malformed envelopes (missing jobId/agentId/event)', async () => {
    const { stdout, stderr } = makeStreams();
    const bus = new JobBus();
    const seen: Envelope[] = [];
    bus.subscribe('j1', (env) => seen.push(env));

    const promise = consumeJsonlStream({ stdout, stderr, bus, expectedJobId: 'j1' });

    stdout.write(JSON.stringify({ jobId: 'j1' }) + '\n'); // missing agentId
    stdout.write(JSON.stringify({ jobId: 'j1', agentId: 'a' }) + '\n'); // missing event
    stdout.write(JSON.stringify(envelope('j1', 'a', 'good')) + '\n');
    stdout.end();
    stderr.end();

    await promise;
    expect(seen).toHaveLength(1);
  });

  it('fires onSentinel callback exactly when the sentinel arrives', async () => {
    const { stdout, stderr } = makeStreams();
    const bus = new JobBus();
    let sentinelCallCount = 0;
    let sentinelStatus: string | undefined;

    const promise = consumeJsonlStream({
      stdout,
      stderr,
      bus,
      expectedJobId: 'j1',
      onSentinel: (s) => {
        sentinelCallCount += 1;
        sentinelStatus = s.status;
      },
    });

    stdout.write(JSON.stringify(envelope('j1', 'a', 'noise')) + '\n');
    stdout.write(
      JSON.stringify({ kind: 'job-complete', jobId: 'j1', status: 'failed' }) + '\n'
    );
    stdout.end();
    stderr.end();

    await promise;
    expect(sentinelCallCount).toBe(1);
    expect(sentinelStatus).toBe('failed');
  });
});

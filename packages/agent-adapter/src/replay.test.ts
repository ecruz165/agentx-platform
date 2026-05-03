import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterEventBus, type AdapterEvent } from './events.ts';
import { replayThenSubscribe } from './replay.ts';

const tmpFile = () => join(tmpdir(), `agentx-replay-${randomUUID()}.jsonl`);

const writeJsonl = async (path: string, events: AdapterEvent[]) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
};

describe('replayThenSubscribe', () => {
  const created: string[] = [];
  afterEach(async () => {
    for (const path of created.splice(0)) {
      await rm(path, { force: true });
    }
  });

  it('replays historical events from the file in order', async () => {
    const path = tmpFile();
    created.push(path);
    await writeJsonl(path, [
      { kind: 'request', ts: 't1', user: 'u1', model: 'm' },
      { kind: 'response', ts: 't2', text: 'r1' },
      { kind: 'request', ts: 't3', user: 'u2', model: 'm' },
    ]);

    const bus = new AdapterEventBus();
    const seen: AdapterEvent[] = [];

    await replayThenSubscribe(path, bus, (e) => seen.push(e));

    expect(seen.map((e) => e.kind)).toEqual(['request', 'response', 'request']);
    const userEvents = seen.filter((e): e is Extract<AdapterEvent, { kind: 'request' }> => e.kind === 'request');
    expect(userEvents.map((e) => e.user)).toEqual(['u1', 'u2']);
  });

  it('treats a missing file as no history and still subscribes live', async () => {
    const bus = new AdapterEventBus();
    const seen: AdapterEvent[] = [];

    const off = await replayThenSubscribe(
      '/tmp/agentx-definitely-does-not-exist.jsonl',
      bus,
      (e) => seen.push(e)
    );

    expect(seen).toHaveLength(0);

    bus.emit({ kind: 'request', ts: 't', user: 'u', model: 'm' });
    expect(seen).toHaveLength(1);

    off();
  });

  it('treats an empty file as no history', async () => {
    const path = tmpFile();
    created.push(path);
    await writeFile(path, '', 'utf8');

    const bus = new AdapterEventBus();
    const seen: AdapterEvent[] = [];

    await replayThenSubscribe(path, bus, (e) => seen.push(e));

    expect(seen).toHaveLength(0);
  });

  it('skips malformed lines (truncated writer tail)', async () => {
    const path = tmpFile();
    created.push(path);
    const valid = JSON.stringify({ kind: 'request', ts: 't1', user: 'u', model: 'm' });
    await writeFile(path, valid + '\n{"kind":"response","ts":"t2","text":"only-half\n', 'utf8');

    const bus = new AdapterEventBus();
    const seen: AdapterEvent[] = [];

    await replayThenSubscribe(path, bus, (e) => seen.push(e));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe('request');
  });

  it('continues replay when handler throws on one event', async () => {
    const path = tmpFile();
    created.push(path);
    await writeJsonl(path, [
      { kind: 'request', ts: 't1', user: 'first', model: 'm' },
      { kind: 'request', ts: 't2', user: 'second', model: 'm' },
      { kind: 'request', ts: 't3', user: 'third', model: 'm' },
    ]);

    const bus = new AdapterEventBus();
    const seen: AdapterEvent[] = [];

    await replayThenSubscribe(path, bus, (e) => {
      if ((e as Extract<AdapterEvent, { kind: 'request' }>).user === 'second') {
        throw new Error('boom');
      }
      seen.push(e);
    });

    expect(seen).toHaveLength(2);
    const users = seen
      .filter((e): e is Extract<AdapterEvent, { kind: 'request' }> => e.kind === 'request')
      .map((e) => e.user);
    expect(users).toEqual(['first', 'third']);
  });

  it('delivers live events emitted after replay completes', async () => {
    const path = tmpFile();
    created.push(path);
    await writeJsonl(path, [{ kind: 'request', ts: 't1', user: 'historical', model: 'm' }]);

    const bus = new AdapterEventBus();
    const seen: AdapterEvent[] = [];

    await replayThenSubscribe(path, bus, (e) => seen.push(e));

    bus.emit({ kind: 'response', ts: 't2', text: 'live' });

    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ kind: 'response', text: 'live' });
  });

  it('returned unsubscribe stops live delivery (history already replayed)', async () => {
    const path = tmpFile();
    created.push(path);
    await writeJsonl(path, [{ kind: 'request', ts: 't1', user: 'historical', model: 'm' }]);

    const bus = new AdapterEventBus();
    const seen: AdapterEvent[] = [];

    const off = await replayThenSubscribe(path, bus, (e) => seen.push(e));
    expect(seen).toHaveLength(1);

    off();
    bus.emit({ kind: 'response', ts: 't2', text: 'after-off' });

    expect(seen).toHaveLength(1);
  });

  // Pending until the gap-handling policy is chosen (see TODO in replay.ts).
  it.todo('does not lose events emitted between file-read and live-subscribe');
});

import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileEventSubscriber, redactEvent } from './capture.ts';
import type { AdapterEvent } from './events.ts';

const tmpFile = () => join(tmpdir(), `agentx-events-${randomUUID()}.jsonl`);

describe('FileEventSubscriber', () => {
  const created: string[] = [];
  afterEach(async () => {
    for (const path of created.splice(0)) {
      await rm(path, { force: true });
    }
  });

  it('appends each event as a JSON line in emit order', async () => {
    const path = tmpFile();
    created.push(path);
    const file = new FileEventSubscriber(path);

    file.handler({ kind: 'request', ts: 't1', user: 'u', model: 'm' });
    file.handler({ kind: 'response', ts: 't2', text: 'hi' });
    await file.drain();

    const content = await readFile(path, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).kind).toBe('request');
    expect(JSON.parse(lines[1]!).kind).toBe('response');
  });

  it('drain() resolves only after all queued writes complete', async () => {
    const path = tmpFile();
    created.push(path);
    const file = new FileEventSubscriber(path);

    for (let i = 0; i < 5; i++) {
      file.handler({ kind: 'request', ts: `t${i}`, user: `u${i}`, model: 'm' });
    }
    await file.drain();

    const content = await readFile(path, 'utf8');
    expect(content.trim().split('\n')).toHaveLength(5);
  });

  it('creates parent directories on first write', async () => {
    const path = join(tmpdir(), `agentx-events-${randomUUID()}`, 'nested', 'deep.jsonl');
    created.push(path);
    const file = new FileEventSubscriber(path);

    file.handler({ kind: 'request', ts: 't', user: 'u', model: 'm' });
    await file.drain();

    const content = await readFile(path, 'utf8');
    expect(content.length).toBeGreaterThan(0);
  });
});

describe('redactEvent', () => {
  it('returns the event unchanged today (no-op TODO)', () => {
    const event: AdapterEvent = {
      kind: 'request',
      ts: '2026-01-01T00:00:00Z',
      user: 'plain text',
      model: 'm',
    };
    expect(redactEvent(event)).toBe(event);
  });

  // The following are pending until the user implements redactEvent (capture.ts TODO).
  it.todo('redacts sk-ant-* tokens that appear in request.user');
  it.todo('redacts sk-(proj-)?* tokens that appear in response.text');
  it.todo('redacts AIza* tokens nested inside response.raw');
  it.todo('preserves event shape (kind/ts) when patterns match');
  it.todo('is allocation-free when no patterns match');
});

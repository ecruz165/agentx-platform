/**
 * CopilotChatAdapter tests.
 *
 * Uses fetchFn injection to stub both the GitHub Copilot session-token
 * exchange AND the chat-completions call, so tests run offline without
 * touching the real Copilot API.
 *
 * Coverage:
 *   - reads GitHub OAuth token from auth.json
 *   - throws if not authenticated (placeholder credential)
 *   - exchanges OAuth → session token
 *   - posts chat with session token + Copilot-Integration headers
 *   - returns response.choices[0].message.content
 *   - emits request + response events
 *   - emits error event + rethrows on chat failure
 *   - 401 retry: clears cached session token, re-exchanges, retries chat
 *   - persists exchanged session token to auth.json (caching)
 *   - reuses cached session token when still valid (skips exchange)
 *   - sends model param + system+user message ordering correctly
 */

import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopilotChatAdapter } from './copilot-chat-adapter.ts';
import type { AdapterEvent } from './events.ts';

let workspace: string;
let authPath: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'copilot-adapter-test-'));
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  authPath = join(workspace, 'auth.json');
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function writeAuth(providers: Record<string, unknown>): void {
  writeFileSync(authPath, JSON.stringify({ version: 1, providers }), { mode: 0o600 });
  chmodSync(authPath, 0o600);
}

interface MockResponse {
  status: number;
  body: unknown;
}

/** Build a fetch stub that returns canned responses. Keyed by URL prefix. */
function makeFetchStub(routes: Record<string, MockResponse | (() => MockResponse)>): {
  fn: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : '';
    calls.push({ url, init });
    const matchKey = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!matchKey) {
      return new Response('not stubbed', { status: 599 });
    }
    const route = routes[matchKey]!;
    const r = typeof route === 'function' ? route() : route;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('CopilotChatAdapter', () => {
  it('throws when github-copilot is not configured', async () => {
    writeAuth({});
    const adapter = new CopilotChatAdapter({ authPath });
    await expect(adapter.invoke({ user: 'hi' })).rejects.toThrow(
      /github-copilot not authenticated/
    );
  });

  it('throws when the credential is the placeholder', async () => {
    writeAuth({ 'github-copilot': { apiKey: 'gho_REPLACE_ME' } });
    const adapter = new CopilotChatAdapter({ authPath });
    await expect(adapter.invoke({ user: 'hi' })).rejects.toThrow(/not authenticated/);
  });

  it('exchanges the GitHub OAuth token for a session token then posts chat', async () => {
    writeAuth({ 'github-copilot': { apiKey: 'gho_real-github-token' } });
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const { fn, calls } = makeFetchStub({
      'https://api.github.com/copilot_internal/v2/token': {
        status: 200,
        body: { token: 'session-token-abc', expires_at: expiresAt },
      },
      'https://api.githubcopilot.com/chat/completions': {
        status: 200,
        body: { choices: [{ message: { content: 'Hello from Copilot.' } }] },
      },
    });

    const adapter = new CopilotChatAdapter({ authPath, fetchFn: fn });
    const result = await adapter.invoke({ user: 'hi' });

    expect(result).toBe('Hello from Copilot.');

    // First call: token exchange against api.github.com
    expect(calls[0]!.url).toBe('https://api.github.com/copilot_internal/v2/token');
    expect((calls[0]!.init?.headers as Record<string, string>)?.Authorization).toBe(
      'token gho_real-github-token'
    );

    // Second call: chat against api.githubcopilot.com with session token
    expect(calls[1]!.url).toBe('https://api.githubcopilot.com/chat/completions');
    const headers = calls[1]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer session-token-abc');
    expect(headers['Copilot-Integration-Id']).toBe('vscode-chat');
  });

  it('caches the exchanged session token to auth.json', async () => {
    writeAuth({ 'github-copilot': { apiKey: 'gho_token' } });
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const { fn } = makeFetchStub({
      'https://api.github.com': { status: 200, body: { token: 'cached-session', expires_at: expiresAt } },
      'https://api.githubcopilot.com': { status: 200, body: { choices: [{ message: { content: 'ok' } }] } },
    });

    const adapter = new CopilotChatAdapter({ authPath, fetchFn: fn });
    await adapter.invoke({ user: 'hi' });

    const file = JSON.parse(require('node:fs').readFileSync(authPath, 'utf8')) as {
      providers: Record<string, { copilotToken?: string; copilotTokenExpiresAt?: number }>;
    };
    expect(file.providers['github-copilot']?.copilotToken).toBe('cached-session');
    expect(file.providers['github-copilot']?.copilotTokenExpiresAt).toBe(expiresAt);
  });

  it('reuses a cached session token when more than 5 minutes remain', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    writeAuth({
      'github-copilot': {
        apiKey: 'gho_token',
        copilotToken: 'still-valid-session',
        copilotTokenExpiresAt: expiresAt,
      },
    });
    const { fn, calls } = makeFetchStub({
      'https://api.github.com': { status: 599, body: 'should not be called' },
      'https://api.githubcopilot.com': { status: 200, body: { choices: [{ message: { content: 'ok' } }] } },
    });
    const adapter = new CopilotChatAdapter({ authPath, fetchFn: fn });
    await adapter.invoke({ user: 'hi' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.githubcopilot.com/chat/completions');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer still-valid-session');
  });

  it('exchanges fresh token when cached one is near expiration (<5 min)', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 60; // 1 minute
    writeAuth({
      'github-copilot': {
        apiKey: 'gho_token',
        copilotToken: 'about-to-expire',
        copilotTokenExpiresAt: expiresAt,
      },
    });
    const newExpiresAt = Math.floor(Date.now() / 1000) + 3600;
    const { fn, calls } = makeFetchStub({
      'https://api.github.com': { status: 200, body: { token: 'fresh-session', expires_at: newExpiresAt } },
      'https://api.githubcopilot.com': { status: 200, body: { choices: [{ message: { content: 'ok' } }] } },
    });
    const adapter = new CopilotChatAdapter({ authPath, fetchFn: fn });
    await adapter.invoke({ user: 'hi' });

    expect(calls.map((c) => c.url)).toEqual([
      'https://api.github.com/copilot_internal/v2/token',
      'https://api.githubcopilot.com/chat/completions',
    ]);
    const chatHeaders = calls[1]!.init?.headers as Record<string, string>;
    expect(chatHeaders.Authorization).toBe('Bearer fresh-session');
  });

  it('retries once on 401 — clears cache, re-exchanges, retries chat', async () => {
    writeAuth({
      'github-copilot': {
        apiKey: 'gho_token',
        copilotToken: 'stale-session',
        copilotTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    let chatAttempts = 0;
    const { fn, calls } = makeFetchStub({
      'https://api.github.com': { status: 200, body: { token: 'replacement-session', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
      'https://api.githubcopilot.com': () => {
        chatAttempts += 1;
        return chatAttempts === 1
          ? { status: 401, body: { error: 'token revoked' } }
          : { status: 200, body: { choices: [{ message: { content: 'after-retry' } }] } };
      },
    });
    const adapter = new CopilotChatAdapter({ authPath, fetchFn: fn });
    const result = await adapter.invoke({ user: 'hi' });

    expect(result).toBe('after-retry');
    expect(chatAttempts).toBe(2);
    // Sequence: chat (401), token-exchange, chat (200)
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.githubcopilot.com/chat/completions',
      'https://api.github.com/copilot_internal/v2/token',
      'https://api.githubcopilot.com/chat/completions',
    ]);
  });

  it('emits request + response events with the right shape', async () => {
    writeAuth({ 'github-copilot': { apiKey: 'gho_token' } });
    const { fn } = makeFetchStub({
      'https://api.github.com': { status: 200, body: { token: 'sess', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
      'https://api.githubcopilot.com': { status: 200, body: { choices: [{ message: { content: 'reply' } }] } },
    });
    const events: AdapterEvent[] = [];
    const adapter = new CopilotChatAdapter({ authPath, fetchFn: fn, model: 'claude-3-5-sonnet' });
    adapter.events.subscribe((e) => events.push(e));
    await adapter.invoke({ system: 'be brief', user: 'hello' });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: 'request',
      system: 'be brief',
      user: 'hello',
      model: 'claude-3-5-sonnet',
      provider: 'github-copilot',
    });
    expect(events[1]).toMatchObject({
      kind: 'response',
      text: 'reply',
    });
  });

  it('emits error event and rethrows on chat failure that is not 401', async () => {
    writeAuth({ 'github-copilot': { apiKey: 'gho_token' } });
    const { fn } = makeFetchStub({
      'https://api.github.com': { status: 200, body: { token: 'sess', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
      'https://api.githubcopilot.com': { status: 500, body: { error: 'upstream broke' } },
    });
    const events: AdapterEvent[] = [];
    const adapter = new CopilotChatAdapter({ authPath, fetchFn: fn });
    adapter.events.subscribe((e) => events.push(e));
    // Error message format changed in slice 13b — HTTP errors now flow
    // through classifyHttpError which produces typed AdapterError
    // subclasses with structured messages. 500 → ProviderError with
    // context "github-copilot: upstream error (500): …"
    await expect(adapter.invoke({ user: 'hi' })).rejects.toThrow(/upstream error \(500\)/);

    const errorEvent = events.find((e) => e.kind === 'error');
    expect(errorEvent).toBeDefined();
  });

  it('sends system + user messages in the right order', async () => {
    writeAuth({ 'github-copilot': { apiKey: 'gho_token' } });
    const { fn, calls } = makeFetchStub({
      'https://api.github.com': { status: 200, body: { token: 'sess', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
      'https://api.githubcopilot.com': { status: 200, body: { choices: [{ message: { content: 'ok' } }] } },
    });
    const adapter = new CopilotChatAdapter({ authPath, fetchFn: fn });
    await adapter.invoke({ system: 'router rules', user: 'pick a pipeline' });

    const chatCall = calls.find((c) => c.url.includes('githubcopilot.com'));
    const body = JSON.parse((chatCall!.init?.body as string) ?? '{}');
    expect(body.messages).toEqual([
      { role: 'system', content: 'router rules' },
      { role: 'user', content: 'pick a pipeline' },
    ]);
    expect(body.model).toBe('gpt-4o'); // default
    expect(body.stream).toBe(false);
  });

  it('omits system message when not provided', async () => {
    writeAuth({ 'github-copilot': { apiKey: 'gho_token' } });
    const { fn, calls } = makeFetchStub({
      'https://api.github.com': { status: 200, body: { token: 'sess', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
      'https://api.githubcopilot.com': { status: 200, body: { choices: [{ message: { content: 'ok' } }] } },
    });
    const adapter = new CopilotChatAdapter({ authPath, fetchFn: fn });
    await adapter.invoke({ user: 'just a user message' });

    const chatCall = calls.find((c) => c.url.includes('githubcopilot.com'));
    const body = JSON.parse((chatCall!.init?.body as string) ?? '{}');
    expect(body.messages).toEqual([{ role: 'user', content: 'just a user message' }]);
  });

  it('returns empty string when response has no choices', async () => {
    writeAuth({ 'github-copilot': { apiKey: 'gho_token' } });
    const { fn } = makeFetchStub({
      'https://api.github.com': { status: 200, body: { token: 'sess', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
      'https://api.githubcopilot.com': { status: 200, body: { choices: [] } },
    });
    const adapter = new CopilotChatAdapter({ authPath, fetchFn: fn });
    const result = await adapter.invoke({ user: 'hi' });
    expect(result).toBe('');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

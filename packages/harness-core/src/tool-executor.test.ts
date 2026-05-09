/**
 * Unit tests for the `kind: 'tool'` step executor.
 *
 * Drives `makeToolExecutor` directly — no LangGraph compile, no
 * orchestrator. The unit under test is the dispatch + arg-resolution
 * logic; topology integration is exercised by orchestrator.test.ts.
 *
 * Coverage matrix:
 *   - resolver miss        → UnknownTool
 *   - cli success          → state.output = stdout
 *   - cli arg template     → {{name}} substitution from step.args
 *   - cli arg jsonpath     → step.args resolved against state
 *   - cli ENOENT           → UnknownExecutable
 *   - cli non-zero exit    → CliError
 *   - cli allowExitCodes   → exit !== 0 treated as success
 *   - cli timeout          → Timeout
 *   - http 200             → state.output = body
 *   - http 4xx             → HttpError
 *   - http URL template    → {{name}} substituted into endpoint
 *   - http body template   → top-level jsonpath resolves
 *   - http auth bearer     → Authorization header set from broker
 *   - http timeout         → Timeout
 *   - mcp host invokeFn ok → state.output = result.content
 *   - mcp host invokeFn err→ McpError or returned errorName
 *   - mcp no host invokeFn → UnconfiguredMcp
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TaskStep, ToolDef } from './catalog.ts';
import type { FlowStateT } from './flow-graph.ts';
import { makeToolExecutor, type McpResult, type ToolExecutorDeps } from './tool-executor.ts';

function freshState(overrides: Partial<FlowStateT> = {}): FlowStateT {
  return {
    jobId: 'job-1',
    output: '',
    messages: [],
    attempts: {},
    lastExit: null,
    rejectionPayload: null,
    steering: [],
    cancelRequested: false,
    cancelReason: null,
    changedFiles: [],
    ...overrides,
  } as FlowStateT;
}

function toolStep(id: string, toolId: string, args?: Record<string, unknown>): TaskStep {
  return { id, kind: 'tool', config: { toolId, ...(args ? { args } : {}) } };
}

function staticResolver(map: Record<string, ToolDef>) {
  return (id: string) => map[id];
}

// ─── tmp scripts for CLI tests ───────────────────────────────────────────
//
// Some CLI behaviors (non-zero exit, slow run) need a real executable.
// Writing tiny scripts to tmpdir + chmod +x lets the test drive them via
// `cmd: <path>` without going through a shell wrapper — the kernel
// invokes the interpreter from the shebang.

let scriptDir: string;
let exitOneScript: string;
let exitTwoOkayScript: string;
let sleepScript: string;

beforeAll(() => {
  scriptDir = mkdtempSync(join(tmpdir(), 'tool-exec-test-'));
  // Exits 1, no stdout, prints to stderr.
  exitOneScript = join(scriptDir, 'exit-one.sh');
  writeFileSync(exitOneScript, '#!/bin/sh\nprintf bad 1>&2\nexit 1\n', 'utf8');
  chmodSync(exitOneScript, 0o755);
  // Exits 2 with "ok" on stdout — for the allowExitCodes test.
  exitTwoOkayScript = join(scriptDir, 'exit-two-okay.sh');
  writeFileSync(exitTwoOkayScript, '#!/bin/sh\nprintf ok\nexit 2\n', 'utf8');
  chmodSync(exitTwoOkayScript, 0o755);
  // Sleeps a long time — for the timeout test.
  sleepScript = join(scriptDir, 'sleep.sh');
  writeFileSync(sleepScript, '#!/bin/sh\nsleep 5\n', 'utf8');
  chmodSync(sleepScript, 0o755);
});

afterAll(() => {
  rmSync(scriptDir, { recursive: true, force: true });
});

// ─── resolver / config errors ────────────────────────────────────────────

describe('makeToolExecutor: resolver behavior', () => {
  it('returns UnknownTool when toolId does not resolve', async () => {
    const exec = makeToolExecutor(toolStep('t1', 'missing'), {
      toolResolver: staticResolver({}),
    });
    const delta = await exec(freshState());
    expect(delta.lastExit).toMatchObject({
      kind: 'error',
      errorName: 'UnknownTool',
    });
  });

  it('throws when handed a non-tool TaskStep (programming error)', () => {
    const wrongKind = { id: 'g', kind: 'gate', config: { assertions: [] } } as TaskStep;
    expect(() =>
      makeToolExecutor(wrongKind, { toolResolver: staticResolver({}) }),
    ).toThrow(/expected "tool"/);
  });
});

// ─── CLI dispatch ────────────────────────────────────────────────────────

describe('makeToolExecutor: cli kind', () => {
  it('captures stdout into state.output on success', async () => {
    const def: ToolDef = { id: 'echo', kind: 'cli', cmd: '/bin/echo', args: ['hello world'] };
    const exec = makeToolExecutor(toolStep('t', 'echo'), {
      toolResolver: staticResolver({ echo: def }),
    });
    const delta = await exec(freshState());
    expect(delta.lastExit).toMatchObject({ kind: 'success' });
    expect((delta.output as string).trim()).toBe('hello world');
  });

  it('substitutes {{name}} args from step.args', async () => {
    const def: ToolDef = { id: 'echo', kind: 'cli', cmd: '/bin/echo', args: ['{{msg}}'] };
    const exec = makeToolExecutor(toolStep('t', 'echo', { msg: 'from-step' }), {
      toolResolver: staticResolver({ echo: def }),
    });
    const delta = await exec(freshState());
    expect((delta.output as string).trim()).toBe('from-step');
  });

  it('resolves jsonpath args against state', async () => {
    const def: ToolDef = { id: 'echo', kind: 'cli', cmd: '/bin/echo', args: ['{{from-state}}'] };
    const step = toolStep('t', 'echo', {
      'from-state': { kind: 'jsonpath', path: '$.output' },
    });
    const exec = makeToolExecutor(step, { toolResolver: staticResolver({ echo: def }) });
    const delta = await exec(freshState({ output: 'jp-resolved' }));
    expect((delta.output as string).trim()).toBe('jp-resolved');
  });

  it('routes to error edge when a template arg is unset', async () => {
    const def: ToolDef = { id: 'echo', kind: 'cli', cmd: '/bin/echo', args: ['{{absent}}'] };
    const exec = makeToolExecutor(toolStep('t', 'echo'), {
      toolResolver: staticResolver({ echo: def }),
    });
    const delta = await exec(freshState());
    expect(delta.lastExit?.kind).toBe('error');
  });

  it('returns UnknownExecutable when cmd is not on PATH', async () => {
    const def: ToolDef = { id: 'nope', kind: 'cli', cmd: '/this/does/not/exist' };
    const exec = makeToolExecutor(toolStep('t', 'nope'), {
      toolResolver: staticResolver({ nope: def }),
    });
    const delta = await exec(freshState());
    expect(delta.lastExit).toMatchObject({
      kind: 'error',
      errorName: 'UnknownExecutable',
    });
  });

  it('returns CliError on non-zero exit', async () => {
    const def: ToolDef = { id: 'fail', kind: 'cli', cmd: exitOneScript };
    const exec = makeToolExecutor(toolStep('t', 'fail'), {
      toolResolver: staticResolver({ fail: def }),
    });
    const delta = await exec(freshState());
    expect(delta.lastExit).toMatchObject({ kind: 'error', errorName: 'CliError' });
    expect(delta.lastExit?.errorMessage).toContain('exited 1');
  });

  it('treats non-zero exit codes as success when in allowExitCodes', async () => {
    const def: ToolDef = {
      id: 'allowed',
      kind: 'cli',
      cmd: exitTwoOkayScript,
      allowExitCodes: [2],
    };
    const exec = makeToolExecutor(toolStep('t', 'allowed'), {
      toolResolver: staticResolver({ allowed: def }),
    });
    const delta = await exec(freshState());
    expect(delta.lastExit).toMatchObject({ kind: 'success' });
    expect((delta.output as string).trim()).toBe('ok');
  });

  it('returns Timeout when cmd exceeds timeoutMs', async () => {
    const def: ToolDef = {
      id: 'slow',
      kind: 'cli',
      cmd: sleepScript,
      timeoutMs: 100,
    };
    const exec = makeToolExecutor(toolStep('t', 'slow'), {
      toolResolver: staticResolver({ slow: def }),
    });
    const delta = await exec(freshState());
    expect(delta.lastExit).toMatchObject({ kind: 'error', errorName: 'Timeout' });
  });
});

// ─── HTTP dispatch ───────────────────────────────────────────────────────

describe('makeToolExecutor: http kind', () => {
  it('returns response body in state.output on 2xx', async () => {
    const def: ToolDef = {
      id: 'api',
      kind: 'http',
      method: 'GET',
      endpoint: 'https://example.test/echo',
    };
    const fetchFn = vi.fn(async () =>
      new Response('hello', { status: 200, statusText: 'OK' }),
    ) as unknown as typeof fetch;
    const ex = makeToolExecutor(toolStep('t', 'api'), {
      toolResolver: staticResolver({ api: def }),
      fetchFn,
    });
    const delta = await ex(freshState());
    expect(delta.lastExit).toMatchObject({ kind: 'success' });
    expect(delta.output).toBe('hello');
  });

  it('returns HttpError on non-2xx with status + truncated body', async () => {
    const def: ToolDef = {
      id: 'api',
      kind: 'http',
      method: 'GET',
      endpoint: 'https://example.test/oops',
    };
    const fetchFn = vi.fn(async () =>
      new Response('upstream error detail', { status: 502, statusText: 'Bad Gateway' }),
    ) as unknown as typeof fetch;
    const ex = makeToolExecutor(toolStep('t', 'api'), {
      toolResolver: staticResolver({ api: def }),
      fetchFn,
    });
    const delta = await ex(freshState());
    expect(delta.lastExit).toMatchObject({ kind: 'error', errorName: 'HttpError' });
    expect(delta.lastExit?.errorMessage).toContain('502');
    expect(delta.lastExit?.errorMessage).toContain('upstream error detail');
  });

  it('substitutes {{name}} in URL from step.args', async () => {
    const def: ToolDef = {
      id: 'api',
      kind: 'http',
      method: 'GET',
      endpoint: 'https://example.test/users/{{userId}}',
    };
    const fetchFn = vi.fn(async (url: string) =>
      new Response(`saw ${url}`, { status: 200 }),
    ) as unknown as typeof fetch;
    const ex = makeToolExecutor(toolStep('t', 'api', { userId: 'abc' }), {
      toolResolver: staticResolver({ api: def }),
      fetchFn,
    });
    const delta = await ex(freshState());
    expect(delta.output).toContain('https://example.test/users/abc');
  });

  it('resolves jsonpath inside bodyTemplate against args', async () => {
    const def: ToolDef = {
      id: 'api',
      kind: 'http',
      method: 'POST',
      endpoint: 'https://example.test/post',
      bodyTemplate: {
        echo: { kind: 'jsonpath', path: '$.payload' },
        static: 'literal',
      },
    };
    let capturedBody: string | undefined;
    const fetchFn = vi.fn(async (_: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const ex = makeToolExecutor(toolStep('t', 'api', { payload: 'from-state' }), {
      toolResolver: staticResolver({ api: def }),
      fetchFn,
    });
    await ex(freshState());
    expect(capturedBody).toBeDefined();
    expect(JSON.parse(capturedBody!)).toEqual({ echo: 'from-state', static: 'literal' });
  });

  it('injects Authorization: Bearer when auth scheme is bearer', async () => {
    const def: ToolDef = {
      id: 'api',
      kind: 'http',
      method: 'GET',
      endpoint: 'https://example.test/secure',
      auth: { scheme: 'bearer', credentialId: 'openai' },
    };
    let seenAuth: string | undefined;
    const fetchFn = vi.fn(async (_: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      seenAuth = headers.get('authorization') ?? undefined;
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    // Real CredentialBroker shape: getCredential(provider) → Credential
    // with .apiKey. The credentialId test value uses 'openai' since
    // it's a known Provider literal — the v1 constraint documented
    // on fetchCredential.
    const broker = {
      getCredential: vi.fn(async (provider: string) => ({
        provider,
        apiKey: `tok-${provider}`,
        source: 'host-file' as const,
      })),
    } as unknown as ToolExecutorDeps['broker'];
    const ex = makeToolExecutor(toolStep('t', 'api'), {
      toolResolver: staticResolver({ api: def }),
      fetchFn,
      broker,
    });
    await ex(freshState());
    expect(seenAuth).toBe('Bearer tok-openai');
  });

  it('returns Timeout when fetch outlasts timeoutMs', async () => {
    const def: ToolDef = {
      id: 'api',
      kind: 'http',
      method: 'GET',
      endpoint: 'https://example.test/slow',
      timeoutMs: 50,
    };
    const fetchFn = vi.fn(async (_: string, init: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }) as unknown as typeof fetch;
    const ex = makeToolExecutor(toolStep('t', 'api'), {
      toolResolver: staticResolver({ api: def }),
      fetchFn,
    });
    const delta = await ex(freshState());
    expect(delta.lastExit).toMatchObject({ kind: 'error', errorName: 'Timeout' });
  });
});

// ─── MCP dispatch ────────────────────────────────────────────────────────

describe('makeToolExecutor: mcp kind', () => {
  it('puts result.content into state.output on ok', async () => {
    const def: ToolDef = {
      id: 'fs',
      kind: 'mcp',
      server: ['npx', 'fake-mcp'],
      toolName: 'read_file',
    };
    const mcpInvokeFn = vi.fn(
      async (): Promise<McpResult> => ({ ok: true, content: 'file-contents' }),
    );
    const ex = makeToolExecutor(toolStep('t', 'fs'), {
      toolResolver: staticResolver({ fs: def }),
      mcpInvokeFn,
    });
    const delta = await ex(freshState());
    expect(delta.lastExit).toMatchObject({ kind: 'success' });
    expect(delta.output).toBe('file-contents');
    expect(mcpInvokeFn).toHaveBeenCalledOnce();
  });

  it('routes invokeFn-returned errors to error edge with provided errorName', async () => {
    const def: ToolDef = {
      id: 'fs',
      kind: 'mcp',
      server: 'https://mcp.example.test',
      toolName: 'denied',
    };
    const mcpInvokeFn = async (): Promise<McpResult> => ({
      ok: false,
      errorName: 'PermissionDenied',
      errorMessage: 'no read access',
    });
    const ex = makeToolExecutor(toolStep('t', 'fs'), {
      toolResolver: staticResolver({ fs: def }),
      mcpInvokeFn,
    });
    const delta = await ex(freshState());
    expect(delta.lastExit).toMatchObject({
      kind: 'error',
      errorName: 'PermissionDenied',
      errorMessage: 'no read access',
    });
  });

  it('returns UnconfiguredMcp when host did not provide mcpInvokeFn', async () => {
    const def: ToolDef = {
      id: 'fs',
      kind: 'mcp',
      server: 'mcp://x',
      toolName: 'whatever',
    };
    const ex = makeToolExecutor(toolStep('t', 'fs'), {
      toolResolver: staticResolver({ fs: def }),
    });
    const delta = await ex(freshState());
    expect(delta.lastExit).toMatchObject({
      kind: 'error',
      errorName: 'UnconfiguredMcp',
    });
  });
});

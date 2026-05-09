/**
 * Unit tests for the `kind: 'script'` step executor.
 *
 * Coverage:
 *   - bash success: stdin pipeline + HARNESS_STATE_JSON env var.
 *   - bash non-zero exit → ScriptError.
 *   - bash timeout → Timeout.
 *   - bash env passthrough.
 *   - node success: simple stdin echo.
 *   - node syntax error → ScriptError.
 *   - python success (skipped if interpreter absent).
 *   - missing interpreter → UnknownInterpreter.
 *   - non-script TaskStep → throw at construction.
 *
 * Each test spawns a real subprocess. Tests that depend on a specific
 * interpreter self-skip when the binary isn't installed.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TaskStep } from './catalog.ts';
import type { FlowStateT } from './flow-graph.ts';
import { makeScriptExecutor } from './script-executor.ts';

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

function scriptStep(
  id: string,
  language: 'bash' | 'node' | 'python',
  source: string,
  extra: { env?: Record<string, string>; timeoutMs?: number } = {},
): TaskStep {
  return {
    id,
    kind: 'script',
    config: { language, source, ...extra },
  };
}

const HAS_PYTHON =
  existsSync('/usr/bin/python3') || existsSync('/usr/local/bin/python3');

// ─── bash ─────────────────────────────────────────────────────────────────

describe('makeScriptExecutor: bash language', () => {
  it('pipes stdin through stdout (uppercase via tr)', async () => {
    const exec = makeScriptExecutor(scriptStep('s', 'bash', 'tr a-z A-Z'));
    const delta = await exec(freshState({ output: 'hello' }));
    expect(delta.lastExit).toMatchObject({ kind: 'success' });
    expect(delta.output).toBe('HELLO');
  });

  it('exposes HARNESS_STATE_JSON env var with state view', async () => {
    const source = 'printf "%s" "$HARNESS_STATE_JSON"';
    const exec = makeScriptExecutor(scriptStep('s', 'bash', source));
    const delta = await exec(freshState({ output: 'piped' }));
    expect(delta.lastExit).toMatchObject({ kind: 'success' });
    const parsed = JSON.parse(delta.output as string);
    expect(parsed.jobId).toBe('job-1');
    expect(parsed.output).toBe('piped');
    expect(parsed.messages).toBeUndefined();
    expect(parsed.changedFiles).toBeUndefined();
  });

  it('returns ScriptError on non-zero exit', async () => {
    // `false` is the canonical UNIX exit-1 builtin; no shell features
    // beyond the script body itself.
    const exec = makeScriptExecutor(scriptStep('s', 'bash', 'false'));
    const delta = await exec(freshState());
    expect(delta.lastExit).toMatchObject({
      kind: 'error',
      errorName: 'ScriptError',
    });
    expect(delta.lastExit?.errorMessage).toContain('exited 1');
  });

  it('returns Timeout when script exceeds timeoutMs', async () => {
    const exec = makeScriptExecutor(
      scriptStep('s', 'bash', 'sleep 5', { timeoutMs: 100 }),
    );
    const delta = await exec(freshState());
    expect(delta.lastExit).toMatchObject({
      kind: 'error',
      errorName: 'Timeout',
    });
  });

  it('passes ScriptConfig.env values through to the child', async () => {
    const source = 'printf "%s" "$EXTRA_VAR"';
    const exec = makeScriptExecutor(
      scriptStep('s', 'bash', source, { env: { EXTRA_VAR: 'from-config' } }),
    );
    const delta = await exec(freshState());
    expect(delta.output).toBe('from-config');
  });
});

// ─── node ─────────────────────────────────────────────────────────────────

describe('makeScriptExecutor: node language', () => {
  it('runs a simple node script that uppercases stdin', async () => {
    const source = [
      'let buf = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (c) => { buf += c; });',
      'process.stdin.on("end", () => process.stdout.write(buf.toUpperCase()));',
    ].join('\n');
    const exec = makeScriptExecutor(scriptStep('s', 'node', source));
    const delta = await exec(freshState({ output: 'lower' }));
    expect(delta.lastExit).toMatchObject({ kind: 'success' });
    expect(delta.output).toBe('LOWER');
  });

  it('routes node SyntaxError to ScriptError', async () => {
    const exec = makeScriptExecutor(
      scriptStep('s', 'node', 'this is not valid js !!!'),
    );
    const delta = await exec(freshState());
    expect(delta.lastExit).toMatchObject({
      kind: 'error',
      errorName: 'ScriptError',
    });
  });
});

// ─── python ───────────────────────────────────────────────────────────────

describe.skipIf(!HAS_PYTHON)('makeScriptExecutor: python language', () => {
  it('runs a simple python script that uppercases stdin', async () => {
    const source = 'import sys; sys.stdout.write(sys.stdin.read().upper())';
    const exec = makeScriptExecutor(scriptStep('s', 'python', source));
    const delta = await exec(freshState({ output: 'lower' }));
    expect(delta.lastExit).toMatchObject({ kind: 'success' });
    expect(delta.output).toBe('LOWER');
  });
});

// ─── interpreter resolution ──────────────────────────────────────────────

describe('makeScriptExecutor: interpreter resolution', () => {
  it('returns UnknownInterpreter when interpreter binary does not exist', async () => {
    const previous = process.env.AGENTX_BASH_BIN;
    process.env.AGENTX_BASH_BIN = '/nonexistent/path/to/bash';
    try {
      const exec = makeScriptExecutor(scriptStep('s', 'bash', 'echo hi'));
      const delta = await exec(freshState());
      expect(delta.lastExit).toMatchObject({
        kind: 'error',
        errorName: 'UnknownInterpreter',
      });
    } finally {
      if (previous === undefined) delete process.env.AGENTX_BASH_BIN;
      else process.env.AGENTX_BASH_BIN = previous;
    }
  });

  it('throws when handed a non-script TaskStep (programming error)', () => {
    const wrongKind = {
      id: 'g',
      kind: 'gate',
      config: { assertions: [] },
    } as TaskStep;
    expect(() => makeScriptExecutor(wrongKind)).toThrow(/expected "script"/);
  });
});

/**
 * CLI shape tests for `agentx-load`.
 *
 * Spawns the bin script as a subprocess (so we exercise the same code
 * path users hit) and asserts on stdout/stderr/exit-code. Uses Bun
 * since `agentx-load`'s shebang is `#!/usr/bin/env bun`.
 *
 * The end-to-end ingest path (chunker → backend → embedder) is covered
 * by `@agentx/context-loader-core`'s tests; this file is the CLI-shape
 * contract: argv parsing, error messages, exit codes, output formats.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, 'bin.ts');
const HARNESS_CORE = resolve(__dirname, '../../harness-core');

function run(args: string[]): { stdout: string; stderr: string; code: number } {
  const r = spawnSync('bun', [BIN, ...args], { encoding: 'utf8' });
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    code: r.status ?? -1,
  };
}

describe('agentx-load CLI shape', () => {
  it('--help prints usage and exits 0', () => {
    const r = run(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('agentx-load — load context sources');
    expect(r.stdout).toContain('Usage:');
  });

  it('--version prints a version line', () => {
    const r = run(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^agentx-load \d+\.\d+\.\d+/);
  });

  it('types prints the catalog ids', () => {
    const r = run(['types']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('code-full');
    expect(r.stdout).toContain('prose-markdown');
  });

  it('exits 2 with usage on missing positional target', () => {
    const r = run(['--type', 'code-full']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('missing positional target');
  });

  it('exits 2 on missing --type', () => {
    const r = run([HARNESS_CORE, '--backend', 'inmem://', '--embedder-url', 'mock://']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('missing required --type');
  });

  it('exits 2 on missing --backend', () => {
    const r = run([HARNESS_CORE, '--type', 'code-full', '--embedder-url', 'mock://']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('missing required --backend');
  });

  it('exits 2 on unsupported --backend scheme', () => {
    const r = run([
      HARNESS_CORE,
      '--type',
      'code-full',
      '--backend',
      'sqlite://wat',
      '--embedder-url',
      'mock://',
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unsupported backend URL scheme');
  });

  it('exits 2 on bolt:// without password', () => {
    const r = run([
      HARNESS_CORE,
      '--type',
      'code-full',
      '--backend',
      'bolt://localhost:7687',
      '--embedder-url',
      'mock://',
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('requires --backend-password');
  });

  it('exits 2 on invalid --output value', () => {
    const r = run([
      HARNESS_CORE,
      '--type',
      'code-full',
      '--backend',
      'inmem://',
      '--embedder-url',
      'mock://',
      '--output',
      'bogus',
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--output must be one of');
  });

  it('ingests harness-core end-to-end with inmem backend + mock embedder', () => {
    const r = run([
      HARNESS_CORE,
      '--type',
      'code-full',
      '--backend',
      'inmem://',
      '--embedder-url',
      'mock://',
      '--output',
      'silent',
    ]);
    expect(r.code).toBe(0);
    const summary = JSON.parse(r.stdout);
    expect(summary.filesIngested).toBeGreaterThan(0);
    expect(summary.errors).toBe(0);
    expect(summary.vectorsWritten).toBe(summary.chunksWritten);
  });

  it('--output json emits one event per line on stdout', () => {
    const r = run([
      HARNESS_CORE,
      '--type',
      'code-full',
      '--backend',
      'inmem://',
      '--embedder-url',
      'mock://',
      '--output',
      'json',
    ]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split('\n');
    // First several lines are events; the last block is the summary JSON.
    // We can verify by parsing the first line as an event with a known kind.
    const firstEvent = JSON.parse(lines[0]!);
    expect(typeof firstEvent.kind).toBe('string');
  });
});

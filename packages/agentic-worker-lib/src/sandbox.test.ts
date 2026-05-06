/**
 * Sandbox env-redirect tests.
 *
 * Verifies that sandboxEnv produces the right shape (HOME / TMPDIR /
 * TMP / TEMP redirected, credential leakage stripped) without
 * actually spawning child processes — pure-function-y and fast.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxPaths, ensureSandboxDirs, sandboxEnv } from './sandbox.ts';

describe('sandboxPaths', () => {
  it('anchors all three paths under <workspaceRoot>/.harness/', () => {
    const p = sandboxPaths('/ws/root');
    expect(p.home).toBe('/ws/root/.harness/agent_home');
    expect(p.tmpdir).toBe('/ws/root/.harness/tmp');
    expect(p.tmuxSocket).toBe('/ws/root/.harness/tmux.sock');
  });
});

describe('ensureSandboxDirs', () => {
  it('creates HOME + TMPDIR (idempotent)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'agent-sandbox-test-'));
    try {
      await ensureSandboxDirs(ws);
      expect(existsSync(join(ws, '.harness/agent_home'))).toBe(true);
      expect(existsSync(join(ws, '.harness/tmp'))).toBe(true);
      // Re-run shouldn't throw.
      await ensureSandboxDirs(ws);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('sandboxEnv', () => {
  it('redirects HOME / TMPDIR / TMP / TEMP to workspace-private dirs', () => {
    const env = sandboxEnv('/ws/root', { HOME: '/host/home', PATH: '/usr/bin' });
    expect(env.HOME).toBe('/ws/root/.harness/agent_home');
    expect(env.TMPDIR).toBe('/ws/root/.harness/tmp');
    expect(env.TMP).toBe('/ws/root/.harness/tmp');
    expect(env.TEMP).toBe('/ws/root/.harness/tmp');
    // Path stays — the worker still needs to find binaries.
    expect(env.PATH).toBe('/usr/bin');
  });

  it('strips credential leakage (ANTHROPIC_API_KEY / OPENAI_API_KEY / AWS_*)', () => {
    const env = sandboxEnv('/ws', {
      ANTHROPIC_API_KEY: 'sk-host-key',
      OPENAI_API_KEY: 'oa-host-key',
      AWS_ACCESS_KEY_ID: 'AKIA...',
      AWS_SECRET_ACCESS_KEY: 'secret',
      PATH: '/usr/bin',
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });
});

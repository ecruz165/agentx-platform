/**
 * Identity isolation for spawned worker processes.
 *
 * Per agent-worker PRD §2: each worker runs with a redirected
 * environment so it cannot stomp on the host user's HOME or system
 * temp dirs.
 *
 *   HOME    → <workspaceRoot>/.harness/agent_home
 *   TMPDIR  → <workspaceRoot>/.harness/tmp
 *
 * Both directories are created if absent, with mode 0o700 (per
 * decision #5: workspace-private). This is the canonical env-redirect
 * for any process the worker spawns (LLM adapter, tool subprocesses,
 * tmux session shells).
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface SandboxPaths {
  /** workspace-root-anchored agent HOME — env HOME redirects here. */
  home: string;
  /** workspace-root-anchored TMPDIR — env TMPDIR redirects here. */
  tmpdir: string;
  /** workspace-root-anchored tmux socket location. */
  tmuxSocket: string;
}

export function sandboxPaths(workspaceRoot: string): SandboxPaths {
  return {
    home: join(workspaceRoot, '.harness', 'agent_home'),
    tmpdir: join(workspaceRoot, '.harness', 'tmp'),
    tmuxSocket: join(workspaceRoot, '.harness', 'tmux.sock'),
  };
}

/** Create the sandbox directories (idempotent). Doesn't touch the
 *  tmux socket — that's handled by the tmux module. */
export async function ensureSandboxDirs(workspaceRoot: string): Promise<SandboxPaths> {
  const paths = sandboxPaths(workspaceRoot);
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await mkdir(paths.tmpdir, { recursive: true, mode: 0o700 });
  return paths;
}

/**
 * Build the env-var record that a sandboxed child process should
 * inherit. Starts from the parent's env (so PATH, language, etc. flow
 * through), then overrides HOME/TMPDIR/TMP/TEMP and clears CLAUDE-*
 * env vars that might leak host credentials into the worker's adapter
 * (the adapter should pull credentials via the in-workspace broker,
 * not from the parent process).
 *
 * Use as: spawn(cmd, args, { env: sandboxEnv(workspaceRoot, process.env), ... })
 */
export function sandboxEnv(
  workspaceRoot: string,
  parentEnv: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const paths = sandboxPaths(workspaceRoot);
  const out: NodeJS.ProcessEnv = { ...parentEnv };
  out.HOME = paths.home;
  out.TMPDIR = paths.tmpdir;
  // Some tools check TMP/TEMP instead of TMPDIR (Windows compat habit).
  out.TMP = paths.tmpdir;
  out.TEMP = paths.tmpdir;
  // Strip leakage paths — the adapter pulls credentials via
  // CredentialBroker (per agent-auth-lib), not from these env vars.
  delete out.ANTHROPIC_API_KEY;
  delete out.OPENAI_API_KEY;
  delete out.AWS_ACCESS_KEY_ID;
  delete out.AWS_SECRET_ACCESS_KEY;
  return out;
}

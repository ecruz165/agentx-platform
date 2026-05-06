/**
 * tmux session management for the agent worker.
 *
 * Per agent-worker PRD §3 + §4: each worker creates its own tmux
 * session at <workspaceRoot>/.harness/tmux.sock, named `agent-<jobId>`,
 * and the developer can `harness attach <jobId>` (with `-r` for
 * read-only) to peek.
 *
 * v1 surface: thin wrappers around the tmux CLI. Real implementations
 * spawn agent commands inside the session via `tmux send-keys` or
 * `tmux new-window`; for the proof slice we expose just enough to
 * create + tear down the session, set its title, and check readiness.
 */

import { spawn } from 'node:child_process';
import { sandboxPaths } from './sandbox.ts';

export interface TmuxSession {
  socketPath: string;
  sessionName: string;
  /** Tear down the session. Idempotent — safe to call after the
   *  process inside has already exited. */
  kill(): Promise<void>;
}

/**
 * Create a detached tmux session for this jobId. Returns a handle the
 * caller can use to send commands or kill the session.
 *
 * The `agent-<jobId>` naming convention matches what `harness attach
 * <jobId>` (in harness-cli) expects. tmux 3.0+ on the host is
 * required; we don't try to bundle a tmux build.
 */
export async function startAgentTmuxSession(args: {
  workspaceRoot: string;
  jobId: string;
}): Promise<TmuxSession> {
  const { tmuxSocket } = sandboxPaths(args.workspaceRoot);
  const sessionName = `agent-${args.jobId}`;
  // -d: detached. The agent inside the session is launched separately
  //     via send-keys / new-window after this.
  // -s: session name.
  await runTmux(['-S', tmuxSocket, 'new-session', '-d', '-s', sessionName, ':']);
  return {
    socketPath: tmuxSocket,
    sessionName,
    async kill() {
      try {
        await runTmux(['-S', tmuxSocket, 'kill-session', '-t', sessionName]);
      } catch {
        /* already gone */
      }
    },
  };
}

/** Run a foreground tmux command, capture stderr for diagnostics. */
function runTmux(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tmux ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}

/** Send a literal command line to the session's first window — the
 *  shell there executes it. Used by the worker to launch the agent
 *  binary inside the sandboxed terminal. */
export function tmuxSendCommand(
  session: TmuxSession,
  commandLine: string
): Promise<void> {
  return runTmux([
    '-S',
    session.socketPath,
    'send-keys',
    '-t',
    session.sessionName,
    commandLine,
    'Enter',
  ]);
}

/**
 * `workspace tmux` — launch the agentx ops dashboard in tmux.
 *
 * Delegates to the existing `scripts/dev-tmux.sh` at the platform root,
 * which sets up a 5-pane layout (TUI + ops shell + harness/memory/context
 * server logs). Idempotent: if the session already exists, attaches to it.
 *
 * Same root-resolution rules as `workspace start`: respects
 * AGENTX_PLATFORM_ROOT, falls back to cwd, errors with a clear message
 * if neither has a `scripts/dev-tmux.sh`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface TmuxOptions {
  platformRoot?: string;
  /** Override the tmux session name (default agentx; mirrors AGENTX_TMUX_SESSION). */
  session?: string;
}

export async function runTmux(opts: TmuxOptions): Promise<void> {
  const root = resolveRoot(opts.platformRoot);
  const script = join(root, 'scripts', 'dev-tmux.sh');
  if (!existsSync(script)) {
    console.error(`error: ${script} not found.`);
    console.error('set AGENTX_PLATFORM_ROOT or cd to the agentx-platform repo root.');
    process.exit(2);
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.session) env.AGENTX_TMUX_SESSION = opts.session;

  // dev-tmux.sh ends with `exec tmux attach`, taking over the TTY. We
  // proxy stdio so the user lands directly inside the session.
  const child = spawn('bash', [script], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => {
    console.error(`failed to launch tmux dashboard: ${err.message}`);
    process.exit(1);
  });
}

function resolveRoot(override?: string): string {
  if (override) return override;
  if (process.env.AGENTX_PLATFORM_ROOT) return process.env.AGENTX_PLATFORM_ROOT;
  return process.cwd();
}

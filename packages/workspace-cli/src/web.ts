/**
 * `workspace web` — open the browser to the control-plane UI.
 *
 * Defaults to the Vite dev server (http://localhost:5173). The user is
 * responsible for running `workspace start` first; if servers are down,
 * the browser will land on a broken page and that's expected.
 *
 * Cross-platform via the host's native opener: macOS `open`, Linux
 * `xdg-open`, Windows `start` (via cmd /c). No npm dep.
 */

import { spawn } from 'node:child_process';

export interface WebOptions {
  url?: string;
  open?: boolean;
}

const DEFAULT_URL = 'http://localhost:5173';

export async function runWeb(opts: WebOptions): Promise<void> {
  const url = opts.url ?? DEFAULT_URL;
  const shouldOpen = opts.open !== false;

  if (!shouldOpen) {
    console.log(url);
    return;
  }

  const platform = process.platform;
  let command: string;
  let args: string[];
  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  console.log(`opening ${url} ...`);
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', (err) => {
    console.error(`failed to open browser: ${err.message}`);
    console.error(`url: ${url}`);
    process.exit(1);
  });
  child.unref();
}

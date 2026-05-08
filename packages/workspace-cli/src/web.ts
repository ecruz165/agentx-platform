/**
 * `workspace web` — open the browser to the control-plane UI.
 *
 * Defaults to the dockerized controlplane (http://localhost:8080) which
 * bundles the UI as Spring static resources. For UI dev work against the
 * Vite dev server instead, pass `--url http://localhost:5173`.
 *
 * Cross-platform via the host's native opener: macOS `open`, Linux
 * `xdg-open`, Windows `start` (via cmd /c). No npm dep.
 */

import { spawn } from 'node:child_process';

export interface WebOptions {
  url?: string;
  open?: boolean;
}

const DEFAULT_URL = 'http://localhost:8080';

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

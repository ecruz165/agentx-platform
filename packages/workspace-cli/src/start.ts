/**
 * `workspace start` — boot the local agentx platform via docker compose.
 *
 * Composes the base controlplane/compose.yaml with one per-variant
 * embedder overlay (compose.<variant>.yaml). The base brings up
 * central-data (postgres + neo4j) + controlplane (Spring + bundled UI);
 * the overlay adds an embedder configuration — either a Docker Model
 * Runner attachment (local Qwen variants) or pure env-var configuration
 * (OpenAI / Bedrock cloud APIs).
 *
 * Same root-resolution rules as `workspace tmux` — respects
 * AGENTX_PLATFORM_ROOT, falls back to cwd, errors with a clear message
 * if neither has a `controlplane/compose.yaml`.
 *
 * Foreground vs detached: `docker compose up -d` always; the daemon
 * model is the right one once we're docker-native (multiplexed logs
 * stay accessible via `docker compose logs -f`).
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type EmbedderVariant =
  | 'qwen-0.6b'
  | 'qwen-4b'
  | 'qwen-8b'
  | 'openai'
  | 'bedrock';

export interface StartOptions {
  /** Embedder variant; default 'qwen-0.6b'. */
  embedder?: EmbedderVariant;
  /** Override the platform root (default: env AGENTX_PLATFORM_ROOT or cwd). */
  platformRoot?: string;
  /** Skip detached mode; tail logs after up. */
  follow?: boolean;
}

const VALID_VARIANTS: EmbedderVariant[] = [
  'qwen-0.6b',
  'qwen-4b',
  'qwen-8b',
  'openai',
  'bedrock',
];

export async function runStart(opts: StartOptions): Promise<void> {
  const variant = opts.embedder ?? 'qwen-0.6b';
  if (!VALID_VARIANTS.includes(variant)) {
    console.error(`error: unknown --embedder value '${variant}'.`);
    console.error(`valid values: ${VALID_VARIANTS.join(', ')}`);
    process.exit(2);
  }

  const root = resolveRoot(opts.platformRoot);
  const composeDir = join(root, 'controlplane');
  const baseFile = join(composeDir, 'compose.yaml');
  const overlayFile = join(composeDir, `compose.${variant}.yaml`);

  if (!existsSync(baseFile)) {
    console.error(`error: ${baseFile} not found.`);
    console.error('set AGENTX_PLATFORM_ROOT or cd to the agentx-platform repo root.');
    process.exit(2);
  }
  if (!existsSync(overlayFile)) {
    console.error(`error: overlay ${overlayFile} not found.`);
    process.exit(2);
  }

  console.log(`[workspace] starting platform (embedder=${variant})…`);
  console.log(`[workspace] compose: -f ${baseFile} -f ${overlayFile}`);

  const args = [
    'compose',
    '-f',
    baseFile,
    '-f',
    overlayFile,
    'up',
    '-d',
  ];

  await runDocker(args, composeDir);

  console.log('');
  console.log('[workspace] up; tail logs with:');
  console.log(`  docker compose -f ${baseFile} -f ${overlayFile} logs -f`);
  console.log('[workspace] open the UI:');
  console.log('  workspace web');
  console.log('[workspace] tear down:');
  console.log(`  docker compose -f ${baseFile} -f ${overlayFile} down`);
}

function resolveRoot(override?: string): string {
  if (override) return override;
  if (process.env.AGENTX_PLATFORM_ROOT) return process.env.AGENTX_PLATFORM_ROOT;
  return process.cwd();
}

function runDocker(args: string[], cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child: ChildProcess = spawn('docker', args, {
      cwd,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker compose exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

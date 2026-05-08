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
import { runBuildWorker } from './build-worker.ts';

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
  /**
   * When set, the local stack runs only edge-server + harness-server,
   * and harness-server reports to the controlplane URL provided here.
   * Useful when the controlplane is hosted (prod / shared-team) and
   * you only want the laptop-side edge containers.
   */
  remoteControlplane?: string;
  /**
   * Force-rebuild the worker devcontainer image even if it already
   * exists locally. Default: skip rebuild when present.
   */
  rebuildWorker?: boolean;
  /**
   * Skip the worker image build entirely. Useful when you already have
   * agentx/worker:dev present and want a faster start.
   */
  skipWorker?: boolean;
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
  const remoteOverlayFile = join(composeDir, 'compose.remote-controlplane.yaml');

  if (!existsSync(baseFile)) {
    console.error(`error: ${baseFile} not found.`);
    console.error('set AGENTX_PLATFORM_ROOT or cd to the agentx-platform repo root.');
    process.exit(2);
  }
  if (!existsSync(overlayFile)) {
    console.error(`error: overlay ${overlayFile} not found.`);
    process.exit(2);
  }

  const composeFiles = [baseFile, overlayFile];
  let services: string[] = [];          // empty = "all in compose"
  let envOverrides: NodeJS.ProcessEnv = {};

  if (opts.remoteControlplane) {
    if (!existsSync(remoteOverlayFile)) {
      console.error(`error: ${remoteOverlayFile} not found.`);
      process.exit(2);
    }
    composeFiles.push(remoteOverlayFile);
    // Bring up only the laptop-side services; central-data + controlplane
    // are remote.
    services = ['edge-server', 'harness-server'];
    envOverrides.CONTROLPLANE_URL = opts.remoteControlplane;
    console.log(
      `[workspace] starting (embedder=${variant}, remote controlplane=${opts.remoteControlplane})…`,
    );
  } else {
    console.log(`[workspace] starting platform (embedder=${variant})…`);
  }

  console.log(`[workspace] compose: ${composeFiles.map((f) => `-f ${f}`).join(' ')}`);

  const args = [
    'compose',
    ...composeFiles.flatMap((f) => ['-f', f]),
    'up',
    '-d',
    ...services,
  ];

  await runDocker(args, composeDir, envOverrides);

  // Pre-build the per-job worker devcontainer image (build-once-locally
  // pattern). Each job's devcontainer references agentx/worker:dev
  // rather than rebuilding from workspace-template/.devcontainer/worker/
  // Dockerfile every time. Idempotent: skips when the image already exists.
  if (!opts.skipWorker) {
    console.log('');
    await runBuildWorker({
      force: opts.rebuildWorker,
      platformRoot: opts.platformRoot,
    });
  }

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

function runDocker(
  args: string[],
  cwd: string,
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child: ChildProcess = spawn('docker', args, {
      cwd,
      env: { ...process.env, ...envOverrides },
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker compose exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

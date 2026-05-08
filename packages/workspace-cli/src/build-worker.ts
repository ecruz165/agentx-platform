/**
 * Build the per-job worker devcontainer image once locally + tag it.
 *
 * Pattern B from the workspace-CLI design exchange (build-once-locally):
 * each job's devcontainer references this pre-built tag rather than
 * rebuilding from the workspace-template Dockerfile every time.
 * Faster cold-start; reproducible across jobs on the same host.
 *
 * Idempotent: skips the build if the image already exists locally,
 * unless the caller passes {force: true}.
 *
 * Source: workspace-template/.devcontainer/worker/Dockerfile.
 * Build context: platform repo root (the Dockerfile copies pnpm
 * workspace metadata + packages/* from there).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildWorkerOptions {
  /** Force rebuild even if the image already exists locally. */
  force?: boolean;
  /** Override the platform root (default: env AGENTX_PLATFORM_ROOT or cwd). */
  platformRoot?: string;
  /** Image tag (default: agentx/worker:dev). */
  tag?: string;
}

const DEFAULT_TAG = 'agentx/worker:dev';

export async function runBuildWorker(opts: BuildWorkerOptions): Promise<void> {
  const root = resolveRoot(opts.platformRoot);
  const dockerfile = join(root, 'workspace-template', '.devcontainer', 'worker', 'Dockerfile');
  const tag = opts.tag ?? DEFAULT_TAG;

  if (!existsSync(dockerfile)) {
    console.error(`error: ${dockerfile} not found.`);
    console.error('set AGENTX_PLATFORM_ROOT or cd to the agentx-platform repo root.');
    process.exit(2);
  }

  if (!opts.force && (await imageExists(tag))) {
    console.log(`[build-worker] ${tag} already present; skip (use --force to rebuild)`);
    return;
  }

  console.log(`[build-worker] building ${tag}`);
  console.log(`[build-worker]   dockerfile: ${dockerfile}`);
  console.log(`[build-worker]   context:    ${root}`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'docker',
      ['build', '-f', dockerfile, '-t', tag, root],
      { cwd: root, env: process.env, stdio: 'inherit' },
    );
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker build exited with code ${code}`));
    });
    child.on('error', reject);
  });

  console.log(`[build-worker] tagged ${tag}`);
}

function resolveRoot(override?: string): string {
  if (override) return override;
  if (process.env.AGENTX_PLATFORM_ROOT) return process.env.AGENTX_PLATFORM_ROOT;
  return process.cwd();
}

async function imageExists(tag: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn('docker', ['image', 'inspect', tag], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

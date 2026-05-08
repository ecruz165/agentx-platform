/**
 * `workspace start` — boot the local agentx platform.
 *
 * Spawns the four pieces in parallel with multiplexed prefixed output:
 *   1. controlplane infra (Postgres, Neo4j, embedder) via the existing
 *      controlplane/compose.yaml (`docker compose up -d`).
 *   2. controlplane Spring app (`./mvnw spring-boot:run` from controlplane/).
 *   3. The three TS peer servers (harness / context / memory) via the
 *      existing `examples/04-server-trio.ts` launcher.
 *
 * Foreground mode: terminal stays attached, one Ctrl-C SIGTERMs all
 * children. Daemon mode (--detach) is intentionally deferred to v2.
 *
 * v1 assumes the CLI runs from the agentx-platform repo root (the
 * directory containing both `controlplane/` and `packages/`). When
 * the package is published and installed globally, the user must
 * `cd /path/to/agentx-platform` first; an env var
 * `AGENTX_PLATFORM_ROOT` overrides the cwd assumption.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface StartOptions {
  /** Skip the docker compose step (assume infra already up). */
  skipInfra?: boolean;
  /** Skip the controlplane Spring app (e.g. running it manually for debug). */
  skipControlplane?: boolean;
  /** Skip the TS server trio. */
  skipServers?: boolean;
  /** Override the platform root (default: process.env.AGENTX_PLATFORM_ROOT or cwd). */
  platformRoot?: string;
}

interface ServiceSpec {
  name: string;
  prefix: string;
  cmd: string;
  args: string[];
  cwd?: string;
  color: ColorCode;
  /** Service is short-lived (e.g. `docker compose up -d`); don't track for kill on Ctrl-C. */
  oneshot?: boolean;
}

type ColorCode = 31 | 32 | 33 | 34 | 35 | 36;
const COLOR_RESET = '\x1b[0m';
const colorize = (code: ColorCode, s: string) => `\x1b[${code}m${s}${COLOR_RESET}`;

export async function runStart(opts: StartOptions): Promise<void> {
  const root = resolveRoot(opts.platformRoot);
  if (!existsSync(join(root, 'controlplane'))) {
    console.error(
      `error: not in an agentx-platform repo (no controlplane/ at ${root}).`,
    );
    console.error(`set AGENTX_PLATFORM_ROOT or cd to the repo root.`);
    process.exit(2);
  }

  const services: ServiceSpec[] = [];
  if (!opts.skipInfra) {
    services.push({
      name: 'infra',
      prefix: 'infra ',
      cmd: 'docker',
      args: ['compose', 'up', '-d'],
      cwd: join(root, 'controlplane'),
      color: 36,
      oneshot: true,
    });
  }
  if (!opts.skipControlplane) {
    services.push({
      name: 'controlplane',
      prefix: 'cplane',
      cmd: './mvnw',
      args: ['-q', 'spring-boot:run'],
      cwd: join(root, 'controlplane'),
      color: 32,
    });
  }
  if (!opts.skipServers) {
    services.push({
      name: 'servers',
      prefix: 'serv  ',
      cmd: 'pnpm',
      args: ['tsx', 'examples/04-server-trio.ts'],
      cwd: root,
      color: 33,
    });
  }

  // Run oneshots first, then long-lived services in parallel.
  const longRunning: ServiceSpec[] = [];
  for (const svc of services) {
    if (svc.oneshot) {
      await runOneshot(svc);
    } else {
      longRunning.push(svc);
    }
  }

  if (longRunning.length === 0) {
    console.log('nothing to run.');
    return;
  }

  const procs: { svc: ServiceSpec; child: ChildProcess }[] = [];
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(colorize(31, '\n[workspace] shutting down…'));
    for (const { child } of procs) {
      if (!child.killed) child.kill('SIGTERM');
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  for (const svc of longRunning) {
    const child = spawn(svc.cmd, svc.args, {
      cwd: svc.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push({ svc, child });

    pipeWithPrefix(child.stdout!, svc, process.stdout);
    pipeWithPrefix(child.stderr!, svc, process.stderr);

    child.on('exit', (code, signal) => {
      const tag = colorize(svc.color, `[${svc.prefix}]`);
      const reason = signal ? `signal=${signal}` : `code=${code}`;
      process.stdout.write(`${tag} exited (${reason})\n`);
      if (!shuttingDown) shutdown();
    });
  }

  console.log(colorize(31, '[workspace] started; press Ctrl-C to stop.'));
}

function resolveRoot(override?: string): string {
  if (override) return override;
  if (process.env.AGENTX_PLATFORM_ROOT) return process.env.AGENTX_PLATFORM_ROOT;
  return process.cwd();
}

async function runOneshot(svc: ServiceSpec): Promise<void> {
  const tag = colorize(svc.color, `[${svc.prefix}]`);
  process.stdout.write(`${tag} ${svc.cmd} ${svc.args.join(' ')}\n`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(svc.cmd, svc.args, {
      cwd: svc.cwd,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${svc.name} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

function pipeWithPrefix(
  stream: NodeJS.ReadableStream,
  svc: ServiceSpec,
  out: NodeJS.WritableStream,
): void {
  const tag = colorize(svc.color, `[${svc.prefix}]`);
  let buffer = '';
  stream.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      out.write(`${tag} ${line}\n`);
    }
  });
  stream.on('end', () => {
    if (buffer) out.write(`${tag} ${buffer}\n`);
  });
}

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Per-job worker spawn primitive (workspace-template F18, F24, F25, F37).
 *
 * Workflow when a job lands:
 *   1. Pre-clone each product repo into <workspace>/.harness/repos/<name>.git
 *      as a bare repo (one-time per repo, shared across N parallel jobs).
 *   2. For each repo, `git worktree add <workspace>/.harness/wt/<jobId>/<repoName>`
 *      from the bare clone, on a per-job branch `agent/<jobId>` (F21).
 *   3. Generate a per-job devcontainer override config that mounts:
 *        - the UDS socket dir (so worker reaches always-on triad)
 *        - each worktree at /workspace/<repoName>/ (synthetic monorepo per F19)
 *      with labels harness-worker=true + harness-job-id=<id> for reaping.
 *   4. Return artifacts so harness-server (or a script) can invoke
 *      `devcontainer up --override-config <path>` (per F37).
 *
 * MVP-1 returns artifacts but does not invoke `devcontainer up` itself —
 * that's MVP-2 once the spawn lifecycle is integration-tested. If a clone
 * fails (private repo, no network), the function falls back to empty-bare
 * + placeholder worktree so the override-config flow stays exercisable.
 */
export interface SpawnRepoSpec {
  name: string;
  cloneUrl: string;
  baseRef?: string;
  path?: string;
}

export interface WorkerSpawnSpec {
  jobId: string;
  productId: string;
  pipeline: string;
  name?: string;
  repos: SpawnRepoSpec[];
  workspaceRoot: string;
  /** Optional sub-agent id for fan-out (design.md §6.6). Default: 'main'. */
  subagentId?: string;
}

export interface SpawnedWorktree {
  repo: string;
  path: string;
  containerPath: string;
  branch: string;
  cloned: boolean;
  placeholder?: string;
}

export interface SpawnResult {
  jobId: string;
  subagentId: string;
  containerName: string;
  worktrees: SpawnedWorktree[];
  overrideConfigPath: string;
  spawnCommand: string;
}

export async function spawnWorker(spec: WorkerSpawnSpec): Promise<SpawnResult> {
  const subagentId = spec.subagentId ?? 'main';
  const reposDir = join(spec.workspaceRoot, '.harness', 'repos');
  const wtRoot = join(spec.workspaceRoot, '.harness', 'wt', spec.jobId, subagentId);
  await mkdir(reposDir, { recursive: true, mode: 0o700 });
  await mkdir(wtRoot, { recursive: true, mode: 0o700 });

  const worktrees: SpawnedWorktree[] = [];
  for (const repo of spec.repos) {
    const bareDir = join(reposDir, `${repo.name}.git`);
    let cloned = false;
    let placeholder: string | undefined;

    if (!existsSync(bareDir)) {
      try {
        await runGit(['clone', '--bare', '--depth=1', repo.cloneUrl, bareDir]);
        cloned = true;
      } catch (err) {
        placeholder = (err as Error).message.split('\n')[0]?.slice(0, 120);
        await runGit(['init', '--bare', bareDir]);
      }
    } else {
      cloned = true;
    }

    const branch = `agent/${spec.jobId}${subagentId !== 'main' ? `/${subagentId}` : ''}`;
    const wtPath = join(wtRoot, repo.name);
    try {
      await runGitInDir(bareDir, ['worktree', 'add', wtPath, '-b', branch]);
    } catch {
      await mkdir(wtPath, { recursive: true });
      await writeFile(
        join(wtPath, '.placeholder'),
        `worktree placeholder for ${repo.name} (real clone unavailable)\n`
      );
    }

    worktrees.push({
      repo: repo.name,
      path: wtPath,
      containerPath: repo.path ?? `/workspace/${repo.name}`,
      branch,
      cloned,
      placeholder,
    });
  }

  const containerName =
    subagentId === 'main'
      ? `agentx-job-${spec.jobId}`
      : `agentx-job-${spec.jobId}-${subagentId}`;
  const overrideConfig = {
    name: containerName,
    image: 'agentx/worker:0.0.0',
    runArgs: [
      '--label', 'harness-worker=true',
      '--label', `harness-job-id=${spec.jobId}`,
      '--label', `harness-product=${spec.productId}`,
      '--label', `harness-pipeline=${spec.pipeline}`,
      '--name', containerName,
    ],
    mounts: [
      `source=${join(spec.workspaceRoot, '.harness/run')},target=/root/.harness/run,type=bind`,
      ...worktrees.map(
        (wt) => `source=${wt.path},target=${wt.containerPath},type=bind`
      ),
    ],
    containerEnv: {
      JOB_ID: spec.jobId,
      SUBAGENT_ID: subagentId,
      PRODUCT_ID: spec.productId,
      PIPELINE: spec.pipeline,
      HARNESS_WORKSPACE: '/workspace',
      ...(spec.name ? { JOB_NAME: spec.name } : {}),
    },
    workspaceFolder: '/workspace',
  };

  const overridePath = join(wtRoot, 'devcontainer-override.json');
  await writeFile(overridePath, JSON.stringify(overrideConfig, null, 2));

  const workerTemplate = join(spec.workspaceRoot, 'workspace-template/.devcontainer/worker');
  // --id-label scopes devcontainer-cli's identity per (job, subagent), so concurrent
  // jobs sharing this template folder don't collide and --remove-existing-container
  // only affects retries of the same job, not other in-flight jobs.
  const spawnCommand =
    `devcontainer up --workspace-folder ${workerTemplate} ` +
    `--id-label harness-job-id=${spec.jobId} ` +
    `--id-label harness-subagent=${subagentId} ` +
    `--override-config ${overridePath} --remove-existing-container`;

  return {
    jobId: spec.jobId,
    subagentId,
    containerName,
    worktrees,
    overrideConfigPath: overridePath,
    spawnCommand,
  };
}

function runGit(args: string[]): Promise<void> {
  return runProc('git', args);
}

function runGitInDir(dir: string, args: string[]): Promise<void> {
  return runProc('git', args, dir);
}

function runProc(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], cwd });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
      else resolve();
    });
  });
}

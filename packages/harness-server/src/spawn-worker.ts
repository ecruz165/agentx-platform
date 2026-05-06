import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Per-product baseRef cache. Keyed by bare-repo path. Avoids re-running
 * `symbolic-ref` for every worktree against the same product. Each
 * harness-server process has its own cache; a workspace prune clears the
 * bare repos out and the cache becomes irrelevant.
 */
const baseRefCache = new Map<string, string>();

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
  /**
   * Environment variables forwarded to git child processes (clone /
   * fetch / worktree). Overlays onto the parent process's env via
   * `{ ...process.env, ...cloneEnv }` so callers don't have to
   * re-specify every standard variable.
   *
   * Use cases:
   *   - HTTPS + token: `{ GIT_ASKPASS: '/path/to/token-script' }`
   *     OR set the URL to `https://<token>@github.com/...` directly
   *   - Non-default SSH key: `{ GIT_SSH_COMMAND: 'ssh -i ~/.ssh/agentx_id_ed25519' }`
   *   - Production / ECS: credentials pulled from Secrets Manager
   *     and shaped into a credential-helper config or token URL
   *
   * Default (unset): git inherits the parent's env, including
   * SSH_AUTH_SOCK (ambient ssh-agent). That covers most local-dev
   * setups without any explicit configuration.
   *
   * Container-side credential forwarding (worker push/PR operations)
   * is a separate concern — that goes through the devcontainer's
   * runArgs/containerEnv, NOT this field.
   */
  cloneEnv?: NodeJS.ProcessEnv;
  /**
   * Forward an SSH agent socket INTO the worker container so the
   * worker's git push / `gh pr create` / equivalent operations can
   * authenticate against GitHub. Slice 9d-6.
   *
   * Values:
   *   - `true`  → auto-detect via `process.env.SSH_AUTH_SOCK`. Throws
   *               if SSH_AUTH_SOCK is unset.
   *   - string  → explicit host-path of the SSH agent socket.
   *   - `false` / unset → no forwarding (default — worker has read-
   *               only access to the mounted worktrees but can't
   *               push). Preserves pre-9d-6 behavior.
   *
   * Effect on the override-config:
   *   - mount: `source=<hostPath>,target=/ssh-agent.sock,type=bind`
   *   - containerEnv: `SSH_AUTH_SOCK=/ssh-agent.sock`
   *
   * Use the mount target `/ssh-agent.sock` (vanilla-docker convention)
   * by default; override via `sshAgentContainerPath` for Docker Desktop
   * setups that prefer `/run/host-services/ssh-auth.sock`.
   *
   * Production (ECS / Fargate) doesn't use this — that path is
   * Secrets Manager + a credential helper file, configured by the
   * Fargate task definition rather than devcontainer override-config.
   */
  forwardSshAgent?: boolean | string;
  /**
   * Override the in-container path that the SSH agent socket gets
   * mounted at. Default: `/ssh-agent.sock`. The same value is set
   * as `SSH_AUTH_SOCK` in containerEnv so git automatically uses it.
   *
   * Some setups (Docker Desktop on macOS) prefer
   * `/run/host-services/ssh-auth.sock` because Docker Desktop has
   * built-in handling for that path.
   */
  sshAgentContainerPath?: string;
}

export interface SpawnedWorktree {
  repo: string;
  path: string;
  containerPath: string;
  branch: string;
  /** True when the bare repo exists locally — either freshly cloned this
   *  call OR previously cached. Originally documented as "this repo is
   *  cloned"; kept for backwards compatibility. Use `freshlyCloned` and
   *  `refreshed` for finer state. */
  cloned: boolean;
  /** True only when this call performed the initial `git clone --bare`
   *  (cache miss). False when the bare was already on disk. */
  freshlyCloned: boolean;
  /** True when this call ran `git fetch origin --prune` against an
   *  existing cached bare repo. False on cache miss (where cloning IS
   *  the refresh) and false in placeholder mode (no remote to fetch). */
  refreshed: boolean;
  /** The commit hash the per-job branch was rooted at (resolved
   *  via `git rev-parse HEAD` in the new worktree right after
   *  creation). Captured for audit logs and PR descriptions
   *  ("based on <sha>"). Absent in placeholder mode. */
  baseRef?: string;
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

  // Compose the env that git child processes will see. Overlay on
  // process.env so callers don't have to repeat HOME, PATH, SSH_AUTH_SOCK,
  // etc. — they only specify the overrides (GITHUB_TOKEN,
  // GIT_SSH_COMMAND, ...).
  const gitEnv: NodeJS.ProcessEnv | undefined = spec.cloneEnv
    ? { ...process.env, ...spec.cloneEnv }
    : undefined;

  const worktrees: SpawnedWorktree[] = [];
  for (const repo of spec.repos) {
    const bareDir = join(reposDir, `${repo.name}.git`);
    let freshlyCloned = false;
    let refreshed = false;
    let placeholder: string | undefined;

    if (!existsSync(bareDir)) {
      // First job against this repo — full bare clone. We deliberately
      // do NOT use --depth=1: shallow clones can't host arbitrary-base
      // worktrees cleanly (each per-job branch needs to be rooted in a
      // commit reachable from the bare repo, and shallow histories make
      // that fragile). The bandwidth is paid once per repo per
      // workspace.
      try {
        await runGit(['clone', '--bare', repo.cloneUrl, bareDir], gitEnv);
        freshlyCloned = true;
      } catch (err) {
        placeholder = (err as Error).message.split('\n')[0]?.slice(0, 120);
        await runGit(['init', '--bare', bareDir]);
      }
    } else {
      // Subsequent jobs — refresh the cache so the per-job branch
      // bases off LATEST origin, not the clone-time HEAD. Without this
      // step, a long-lived workspace's jobs progressively drift
      // backwards relative to the actual remote default branch.
      // Skip silently in placeholder mode (no `origin` remote
      // configured); the worktree-add path will then fall through to
      // its placeholder branch.
      try {
        // Explicit fetchspec `+refs/heads/*:refs/heads/*` ensures the
        // bare repo's branch refs (including the default branch HEAD
        // points at) get updated, regardless of how the bare was
        // configured at clone time. The `+` forces fast-forward
        // (which is fine for a bare we never write to ourselves).
        // --prune drops branches that no longer exist on origin.
        await runGitInDir(
          bareDir,
          ['fetch', 'origin', '+refs/heads/*:refs/heads/*', '--prune'],
          gitEnv
        );
        refreshed = true;
      } catch (err) {
        // Likely placeholder bare repo (no remote) or transient
        // network issue. Don't fail the spawn — the worktree-add
        // below will still work off whatever HEAD points at.
        placeholder =
          placeholder ?? (err as Error).message.split('\n')[0]?.slice(0, 120);
      }
    }

    const branch = `agent/${spec.jobId}${subagentId !== 'main' ? `/${subagentId}` : ''}`;
    const wtPath = join(wtRoot, repo.name);
    // worktree-add with no explicit base → branches off HEAD. For
    // bare clones (git clone --bare ...), HEAD is a symbolic ref to
    // refs/heads/<default>, and the fetchspec `+refs/heads/*:refs/heads/*`
    // means `git fetch origin --prune` (above) updated that ref to
    // latest origin tip. So HEAD === latest after fetch — no need
    // for an explicit base. (The symbolic-ref refs/remotes/origin/HEAD
    // dance only works for non-bare clones, which we don't use here.)
    let baseRefHash: string | undefined;
    try {
      await runGitInDir(bareDir, ['worktree', 'add', wtPath, '-b', branch]);
      // Capture the actual commit the worktree was rooted at — useful
      // for audit logs and PR descriptions ("this branch was based on
      // <hash>"). Best-effort: failure here doesn't fail the spawn.
      try {
        baseRefHash = (await runGitOutput(wtPath, ['rev-parse', 'HEAD'])).trim();
      } catch {
        // ignore
      }
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
      cloned: freshlyCloned || existsSync(bareDir),
      freshlyCloned,
      refreshed,
      ...(baseRefHash ? { baseRef: baseRefHash } : {}),
      ...(placeholder ? { placeholder } : {}),
    });
  }

  const containerName =
    subagentId === 'main'
      ? `agentx-job-${spec.jobId}`
      : `agentx-job-${spec.jobId}-${subagentId}`;

  // Slice 9d-6: optional SSH agent socket mount for in-container git
  // auth. Resolves to undefined when forwardSshAgent is false/unset,
  // a {hostPath, containerPath} pair otherwise. Throws on
  // forwardSshAgent: true with no SSH_AUTH_SOCK in the env (loud
  // failure beats silent "your push didn't authenticate").
  const sshMount = resolveSshAgentMount(spec, process.env);

  const baseMounts = [
    `source=${join(spec.workspaceRoot, '.harness/run')},target=/root/.harness/run,type=bind`,
    ...worktrees.map((wt) => `source=${wt.path},target=${wt.containerPath},type=bind`),
  ];
  const baseContainerEnv: Record<string, string> = {
    JOB_ID: spec.jobId,
    SUBAGENT_ID: subagentId,
    PRODUCT_ID: spec.productId,
    PIPELINE: spec.pipeline,
    HARNESS_WORKSPACE: '/workspace',
    ...(spec.name ? { JOB_NAME: spec.name } : {}),
  };

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
    mounts: sshMount
      ? [
          ...baseMounts,
          `source=${sshMount.hostPath},target=${sshMount.containerPath},type=bind`,
        ]
      : baseMounts,
    containerEnv: sshMount
      ? { ...baseContainerEnv, SSH_AUTH_SOCK: sshMount.containerPath }
      : baseContainerEnv,
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

/**
 * Test-only: clear the per-process baseRef cache. Reserved for future
 * use; currently a no-op since 9d-2 does on-demand baseRef capture
 * rather than caching. Kept exported so tests written against the
 * cached-resolver shape continue to work.
 */
export function _clearBaseRefCache(): void {
  baseRefCache.clear();
}

/**
 * Resolve the slice-9d-6 SSH agent mount config from a WorkerSpawnSpec.
 *
 * Returns `{ hostPath, containerPath }` when forwarding is requested,
 * `undefined` when it isn't (default — preserves pre-9d-6 behavior).
 * Throws when `forwardSshAgent: true` is set but no `SSH_AUTH_SOCK`
 * is present in the env — silent failure here would produce a
 * container that "looks fine" but can't auth git pushes, which is
 * a pernicious failure mode.
 *
 * Exported for tests.
 */
export function resolveSshAgentMount(
  spec: Pick<WorkerSpawnSpec, 'forwardSshAgent' | 'sshAgentContainerPath'>,
  env: NodeJS.ProcessEnv = process.env
): { hostPath: string; containerPath: string } | undefined {
  const containerPath = spec.sshAgentContainerPath ?? '/ssh-agent.sock';
  if (spec.forwardSshAgent === undefined || spec.forwardSshAgent === false) {
    return undefined;
  }
  if (typeof spec.forwardSshAgent === 'string') {
    return { hostPath: spec.forwardSshAgent, containerPath };
  }
  // forwardSshAgent === true → auto-detect.
  const fromEnv = env.SSH_AUTH_SOCK;
  if (!fromEnv) {
    throw new Error(
      'forwardSshAgent: true requires SSH_AUTH_SOCK in the environment. ' +
        'Either start an ssh-agent (`eval $(ssh-agent)`) and add your key ' +
        '(`ssh-add ~/.ssh/id_ed25519`), or pass an explicit host path: ' +
        '`forwardSshAgent: "/path/to/ssh-agent.sock"`.'
    );
  }
  return { hostPath: fromEnv, containerPath };
}

// ─── runWorker ────────────────────────────────────────────────────────────
//
// spawnWorker generates artifacts (worktrees + override-config); runWorker
// adds the actual `devcontainer up` invocation on top. Split as separate
// functions so existing callers that just want artifacts (registration
// flow, dry-run smoke tests) don't pull in a Docker dependency.

export interface RunWorkerOptions {
  spec: WorkerSpawnSpec;
  /** Path to the devcontainer CLI. Default: 'devcontainer' on PATH.
   *  Override in tests / custom deployments. */
  devcontainerBin?: string;
  /** Extra args forwarded to `devcontainer up` after the standard
   *  override + id-label flags. Useful for `--platform=linux/arm64`
   *  on Apple Silicon where the worker image is amd64-only. */
  extraUpArgs?: string[];
  /** Hook for tests / observers. Fires once spawnWorker artifacts are
   *  generated, before `devcontainer up` runs. */
  onSpawnArtifacts?: (artifacts: SpawnResult) => void;
}

export interface RunWorkerResult {
  jobId: string;
  subagentId: string;
  containerName: string;
  /** Container ID parsed from `devcontainer up`'s JSON output. The
   *  caller passes this to `devcontainer exec --container-id <id>`
   *  for follow-up steps. */
  containerId: string;
  artifacts: SpawnResult;
}

/**
 * Generate artifacts AND actually invoke `devcontainer up`. The
 * production path that 9d-2 unblocks; previously callers had to take
 * `spawnCommand` from spawnWorker and shell out themselves.
 *
 * `devcontainer up` outputs JSON on stdout (per devcontainer-cli
 * spec). We parse the final newline-terminated object to extract
 * `containerId` — that's the handle for any subsequent
 * `devcontainer exec` calls.
 *
 * Throws on non-zero exit, with stderr included in the error message.
 */
export async function runWorker(opts: RunWorkerOptions): Promise<RunWorkerResult> {
  const artifacts = await spawnWorker(opts.spec);
  opts.onSpawnArtifacts?.(artifacts);

  const bin = opts.devcontainerBin ?? 'devcontainer';
  const workerTemplate = join(
    opts.spec.workspaceRoot,
    'workspace-template/.devcontainer/worker'
  );
  const args = [
    'up',
    '--workspace-folder', workerTemplate,
    '--id-label', `harness-job-id=${opts.spec.jobId}`,
    '--id-label', `harness-subagent=${artifacts.subagentId}`,
    '--override-config', artifacts.overrideConfigPath,
    '--remove-existing-container',
    ...(opts.extraUpArgs ?? []),
  ];

  const { stdout, stderr, code } = await runProcCapture(bin, args);
  if (code !== 0) {
    throw new Error(
      `devcontainer up exited ${code}: ${stderr.trim() || stdout.trim() || '(no output)'}`
    );
  }

  const containerId = parseDevcontainerUpStdout(stdout);
  if (!containerId) {
    throw new Error(
      `devcontainer up succeeded but containerId was not parseable from stdout. ` +
        `First 500 chars: ${stdout.slice(0, 500)}`
    );
  }

  return {
    jobId: opts.spec.jobId,
    subagentId: artifacts.subagentId,
    containerName: artifacts.containerName,
    containerId,
    artifacts,
  };
}

/**
 * Parse `devcontainer up`'s stdout to extract containerId. The CLI
 * emits one or more JSON lines; the success line has shape
 * `{ outcome: 'success', containerId: 'abc123...', ... }`. We scan
 * lines from the end (success message is typically last) and return
 * the first containerId we find.
 *
 * Exported for tests.
 */
export function parseDevcontainerUpStdout(stdout: string): string | undefined {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && typeof obj.containerId === 'string' && obj.containerId.length > 0) {
        return obj.containerId;
      }
    } catch {
      // not JSON; keep scanning
    }
  }
  return undefined;
}

function runGit(args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return runProc('git', args, undefined, env);
}

function runGitInDir(
  dir: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<void> {
  return runProc('git', args, dir, env);
}

function runGitOutput(dir: string, args: string[]): Promise<string> {
  return runProcOutput('git', args, dir);
}

function runProc(
  cmd: string,
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
    });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
      else resolve();
    });
  });
}

/** Run a process and return its stdout. Rejects on non-zero exit with
 *  stderr in the error message. Used for git plumbing commands whose
 *  output (refs, hashes) is the value of the call. */
function runProcOutput(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => (stdout += c.toString()));
    child.stderr?.on('data', (c) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
      else resolve(stdout);
    });
  });
}

/** Run a process and return both stdout, stderr, and exit code. Does
 *  NOT reject on non-zero — callers decide what to do. Used for
 *  `devcontainer up` where we want stderr verbatim in the error path. */
function runProcCapture(
  cmd: string,
  args: string[],
  cwd?: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => (stdout += c.toString()));
    child.stderr?.on('data', (c) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

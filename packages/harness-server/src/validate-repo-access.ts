/**
 * validateRepoAccess — preflight check that each configured repo is
 * reachable with the supplied auth before any clone / fetch fires.
 *
 * Per memory `project_workspace_setup_vision`:
 *   - Setup Phase 2 calls this to gate "should I commit this workspace
 *     to disk?" — fail-fast when a repo URL is wrong or auth isn't
 *     configured, before scaffolding the workspace dir.
 *   - The same predicate is useful at runtime for two more callers:
 *       1. spawnWorker preflight — check before clone/fetch so the
 *          failure surfaces with a clean message instead of buried
 *          inside spawnWorker's error path.
 *       2. `harness workspace prune` (PRD F23) — verify cached bares
 *          still have origin reachability before keeping them.
 *
 * Implementation: `git ls-remote --exit-code <url> HEAD`
 *   - Cheap (no payload, no clone, just ref listing)
 *   - --exit-code makes git fail loud when the ref isn't present
 *     (defensive against weird states like an empty bare repo)
 *   - Parses the resolved HEAD SHA when successful
 *
 * Returns ALL results (both accessible + failures) so callers can
 * present per-repo status to the user. Doesn't throw on per-repo
 * failures — only on programmer errors (e.g., empty input shape).
 */

import { spawn } from 'node:child_process';
import type { SpawnRepoSpec } from './spawn-worker.ts';

export interface RepoAccessCheck {
  repo: SpawnRepoSpec;
  ok: boolean;
  /** Resolved HEAD SHA when ok; undefined when failed. 40 hex chars. */
  head?: string;
  /** Failure reason when !ok — git's stderr message, trimmed. */
  reason?: string;
  /** Suggested fix based on URL form + failure mode. Hand-curated
   *  heuristics; meant to point the user at the next thing to try. */
  suggestion?: string;
  /** Wall time in ms. Useful for spotting hung connections + for
   *  parallel-vs-serial mode comparison. */
  durationMs: number;
}

export interface ValidateRepoAccessOptions {
  repos: readonly SpawnRepoSpec[];
  /**
   * Environment overlay forwarded to `git` child processes. Same
   * shape as `WorkerSpawnSpec.cloneEnv` — overlays on process.env.
   * Use this to inject GITHUB_TOKEN, GIT_SSH_COMMAND, etc. for
   * specific auth methods.
   *
   * For multi-repo runs that need DIFFERENT auth per repo (e.g.,
   * one SSH, one HTTPS+PAT), call this function once per repo with
   * the repo's specific cloneEnv rather than batching.
   */
  cloneEnv?: NodeJS.ProcessEnv;
  /** Run checks in parallel (default true). Sequential is useful for
   *  deterministic test output + when running on a slow disk. */
  parallel?: boolean;
  /** Per-repo timeout in ms. Default 10000 (10s). Hung connections
   *  get killed at this point; the result has ok=false + a timeout
   *  reason. */
  timeoutMs?: number;
}

export interface ValidateRepoAccessResult {
  accessible: RepoAccessCheck[];
  failures: RepoAccessCheck[];
  /** All checks in input order (accessible + failures interleaved
   *  by their original repo position). Useful for displaying status
   *  to the user in submission order. */
  all: RepoAccessCheck[];
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function validateRepoAccess(
  options: ValidateRepoAccessOptions,
): Promise<ValidateRepoAccessResult> {
  const env = options.cloneEnv ? { ...process.env, ...options.cloneEnv } : undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const parallel = options.parallel ?? true;

  const checkOne = (repo: SpawnRepoSpec) => checkRepo(repo, env, timeoutMs);

  let all: RepoAccessCheck[];
  if (parallel) {
    all = await Promise.all(options.repos.map(checkOne));
  } else {
    all = [];
    for (const repo of options.repos) {
      all.push(await checkOne(repo));
    }
  }

  return {
    accessible: all.filter((c) => c.ok),
    failures: all.filter((c) => !c.ok),
    all,
  };
}

async function checkRepo(
  repo: SpawnRepoSpec,
  env: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
): Promise<RepoAccessCheck> {
  const start = Date.now();
  try {
    const stdout = await runLsRemote(repo.cloneUrl, env, timeoutMs);
    const head = parseHeadSha(stdout);
    if (!head) {
      return {
        repo,
        ok: false,
        reason: `git ls-remote succeeded but no HEAD ref found in output:\n${stdout.slice(0, 300)}`,
        suggestion: 'Repository may be empty or have a non-standard default branch.',
        durationMs: Date.now() - start,
      };
    }
    return { repo, ok: true, head, durationMs: Date.now() - start };
  } catch (err) {
    const reason = (err as Error).message;
    return {
      repo,
      ok: false,
      reason,
      suggestion: suggestFix(repo.cloneUrl, reason),
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Run `git ls-remote --exit-code <url> HEAD` and return stdout. The
 * `HEAD` arg restricts output to one ref so we don't pay for a full
 * ref listing on big repos.
 */
function runLsRemote(
  url: string,
  env: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn('git', ['ls-remote', '--exit-code', url, 'HEAD'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env ? { env } : {}),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectP(new Error(`timeout after ${timeoutMs}ms (process killed)`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timeout);
      rejectP(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (signal === 'SIGKILL') return; // already rejected via timeout
      if (code !== 0) {
        const msg = stderr.trim() || stdout.trim() || `git exited ${code}`;
        rejectP(new Error(msg));
        return;
      }
      resolveP(stdout);
    });
  });
}

/**
 * Parse the SHA from `git ls-remote` output. The first line is
 * `<sha>\tHEAD` (or `\trefs/heads/<branch>` if HEAD redirects).
 * Returns the 40-char SHA or undefined if the format is unexpected.
 *
 * Exported for tests.
 */
export function parseHeadSha(stdout: string): string | undefined {
  const firstLine = stdout.split('\n')[0]?.trim();
  if (!firstLine) return undefined;
  const sha = firstLine.split(/\s/)[0];
  return sha && /^[a-f0-9]{40}$/.test(sha) ? sha : undefined;
}

/**
 * Hand-curated suggestions for common failure modes. Heuristics
 * based on URL form + git's stderr text. Returns a short
 * one-liner pointing at the next thing to try, or undefined when
 * the failure isn't recognized.
 *
 * Exported for tests.
 */
export function suggestFix(url: string, reason: string): string | undefined {
  const isSsh = url.startsWith('git@') || url.startsWith('ssh://');
  const isHttps = url.startsWith('https://');
  const lower = reason.toLowerCase();

  // Timeout — applies to either form
  if (lower.includes('timeout')) {
    return 'Connection timed out — check network connectivity and that the host is reachable.';
  }

  if (isSsh) {
    if (lower.includes('permission denied') || lower.includes('publickey')) {
      return (
        'SSH auth failed. Run `ssh-add ~/.ssh/id_ed25519` (or your key path), then retry. ' +
        'Verify with `ssh -T git@github.com`.'
      );
    }
    if (lower.includes('could not resolve hostname') || lower.includes('name or service')) {
      return 'DNS / network issue — host unreachable. Check connectivity.';
    }
    if (lower.includes('repository not found') || lower.includes('does not exist')) {
      // SSH "not found" usually means the user's key doesn't have access
      // (GitHub returns the same error for nonexistent + no-access for
      // privacy reasons).
      return (
        'Repository inaccessible. Either the URL is wrong, OR your SSH key ' +
        "doesn't have access. Try: `ssh -T git@github.com` to confirm identity, " +
        'then check the key has access to this org/repo.'
      );
    }
  }

  if (isHttps) {
    if (lower.includes('authentication failed') || lower.includes('401')) {
      return (
        'HTTPS auth failed. Configure a Git Credential Manager OR provide a ' +
        'PAT via cloneEnv: `{ GIT_ASKPASS: "echo", GIT_USERNAME: "<token>" }` ' +
        'or use SSH form `git@github.com:org/repo.git`.'
      );
    }
    if (lower.includes('repository not found') || lower.includes('404')) {
      return (
        'Repo not found at this URL. Either typo, or repo is private and ' +
        "your credentials don't have access. For private repos, switch to SSH " +
        'form (`git@github.com:org/repo.git`) or configure a PAT with appropriate scopes.'
      );
    }
    if (lower.includes('could not resolve host')) {
      return 'DNS / network issue — host unreachable. Check connectivity.';
    }
  }

  return undefined;
}

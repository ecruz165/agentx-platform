/**
 * `kind: 'publish'` step-kind executor — the `publish-*` delivery family.
 *
 * v1 actions:
 *   - `push-and-open-pr` — push the per-job branch to `origin`, open a PR
 *     via the GitHub REST API, write `{ prUrl, prNumber, branchName }`
 *     into `state.output` (JSON) and onto the JobRecord.
 *   - `merge-pr` — merge a PR opened earlier in the flow (read from
 *     `JobRecord.prUrl`), write `{ mergeSha }` into `state.output` and
 *     onto the JobRecord. Placed after an `approval`-tagged node so it
 *     only runs on the approve edge.
 *
 * Credentials resolve through a {@link GitHubCredentialResolver} cascade
 * supplied via `RunJobDeps.githubResolver` (local `gh` → controlplane
 * App token). The REST calls always use the resolved token; `git push`
 * uses the worker's ambient git auth (SSH agent for SSH remotes) and
 * only embeds the token in the URL for HTTPS remotes.
 *
 * Like the other executors, this never throws under normal flow
 * conditions — failures become `lastExit: { kind: 'error', … }` so the
 * flow's error edge can route around them.
 */

import { spawn } from 'node:child_process';
import type { GitHubCredential, GitHubCredentialResolver } from '@ecruz165/agent-auth';
import type { PublishConfig, TaskStep } from './catalog.ts';
import type { FlowStateT, NodeExecutor } from './flow-graph.ts';
import type { JobRecord } from './job.ts';

type NodeDelta = Partial<FlowStateT>;

const GITHUB_API = 'https://api.github.com';

interface PublishExecutorDeps {
  job: JobRecord;
  /** Resolver cascade for GitHub creds. When absent, publish nodes
   *  fail with `errorName: 'UnconfiguredGitHub'` so the flow can route
   *  around them — same pattern as the tool/subflow resolvers. */
  githubResolver?: GitHubCredentialResolver;
  /** Test seam — substitute global fetch. */
  fetchFn?: typeof fetch;
}

export function makePublishExecutor(node: TaskStep, deps: PublishExecutorDeps): NodeExecutor {
  if (node.kind !== 'publish') {
    throw new Error(`makePublishExecutor: node "${node.id}" has kind "${node.kind}", expected "publish"`);
  }
  const config = node.config as PublishConfig;
  const nodeId = node.id;
  const fetchFn = deps.fetchFn ?? fetch;

  return async (_state) => {
    if (!deps.githubResolver) {
      return err(nodeId, 'UnconfiguredGitHub', `publish node "${nodeId}" cannot run — RunJobDeps.githubResolver is not set`);
    }
    try {
      if (config.action === 'push-and-open-pr') {
        return await runPushAndOpenPr(nodeId, config, deps.job, deps.githubResolver, fetchFn);
      }
      return await runMergePr(nodeId, config, deps.job, deps.githubResolver, fetchFn);
    } catch (e) {
      return err(nodeId, 'PublishFailed', (e as Error).message);
    }
  };
}

// ---------------------------------------------------------------------------
// push-and-open-pr
// ---------------------------------------------------------------------------

async function runPushAndOpenPr(
  nodeId: string,
  config: Extract<PublishConfig, { action: 'push-and-open-pr' }>,
  job: JobRecord,
  resolver: GitHubCredentialResolver,
  fetchFn: typeof fetch,
): Promise<NodeDelta> {
  const repoName = pickRepo(config.repo, job);
  if (!repoName) {
    return err(nodeId, 'AmbiguousRepo', `publish node "${nodeId}": no repo given and product has ${job.productRepos?.length ?? 0} repos — set config.repo`);
  }
  if (!job.workdirRoot) {
    return err(nodeId, 'NoWorkdir', `publish node "${nodeId}": JobRecord.workdirRoot is unset — cannot locate the worktree`);
  }
  const worktree = `${job.workdirRoot}/${repoName}`;

  const branchName = (await git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (!branchName || branchName === 'HEAD') {
    return err(nodeId, 'DetachedHead', `publish node "${nodeId}": worktree is on a detached HEAD — no branch to push`);
  }
  const remoteUrl = (await git(worktree, ['remote', 'get-url', 'origin'])).trim();
  const slug = parseRepoSlug(remoteUrl);
  if (!slug) {
    return err(nodeId, 'UnparseableRemote', `publish node "${nodeId}": could not parse owner/name from origin URL "${remoteUrl}"`);
  }

  const cred = await resolver.resolve({ owner: slug.owner, name: slug.name, remoteUrl });
  if (!cred) {
    return err(nodeId, 'NoGitHubCreds', `publish node "${nodeId}": no GitHub credentials for ${slug.owner}/${slug.name} (tried local gh + controlplane)`);
  }

  // Push. SSH remotes use the worker's SSH agent; HTTPS remotes get the
  // token spliced into the URL for this one push.
  if (isHttpsRemote(remoteUrl)) {
    const authedUrl = remoteUrl.replace(/^https:\/\//, `https://x-access-token:${cred.token}@`);
    await git(worktree, ['push', authedUrl, `${branchName}:${branchName}`]);
  } else {
    await git(worktree, ['push', 'origin', `${branchName}:${branchName}`]);
  }

  // Determine the base branch — explicit config wins; otherwise the
  // repo's default branch from the API.
  const base = config.base ?? (await getDefaultBranch(slug, cred, fetchFn));

  const title = config.title ?? defaultPrTitle(job);
  const body = config.body ?? defaultPrBody(job, base, cred);
  const draft = config.draft ?? false;

  const pr = await ghApi<{ html_url: string; number: number }>(
    fetchFn,
    cred,
    'POST',
    `/repos/${slug.owner}/${slug.name}/pulls`,
    { title, head: branchName, base, body, draft },
  );

  // Record on the JobRecord so the HITL surface + later merge-pr node
  // can find the PR. (Mirrors how the agent executor mutates `job`.)
  job.branchName = branchName;
  job.prUrl = pr.html_url;

  return {
    lastExit: { nodeId, kind: 'success' },
    output: JSON.stringify({ prUrl: pr.html_url, prNumber: pr.number, branchName }),
  };
}

// ---------------------------------------------------------------------------
// merge-pr
// ---------------------------------------------------------------------------

async function runMergePr(
  nodeId: string,
  config: Extract<PublishConfig, { action: 'merge-pr' }>,
  job: JobRecord,
  resolver: GitHubCredentialResolver,
  fetchFn: typeof fetch,
): Promise<NodeDelta> {
  if (!job.prUrl) {
    return err(nodeId, 'NoPr', `merge-pr node "${nodeId}": JobRecord.prUrl is unset — no upstream push-and-open-pr node ran`);
  }
  const ref = parsePrUrl(job.prUrl);
  if (!ref) {
    return err(nodeId, 'UnparseablePrUrl', `merge-pr node "${nodeId}": could not parse owner/name/number from "${job.prUrl}"`);
  }

  const cred = await resolver.resolve({ owner: ref.owner, name: ref.name });
  if (!cred) {
    return err(nodeId, 'NoGitHubCreds', `merge-pr node "${nodeId}": no GitHub credentials for ${ref.owner}/${ref.name}`);
  }

  const method = config.method ?? 'squash';
  const merge = await ghApi<{ sha: string; merged: boolean }>(
    fetchFn,
    cred,
    'PUT',
    `/repos/${ref.owner}/${ref.name}/pulls/${ref.number}/merge`,
    { merge_method: method },
  );
  if (!merge.merged) {
    return err(nodeId, 'MergeRejected', `merge-pr node "${nodeId}": GitHub reported merged=false for PR #${ref.number}`);
  }

  job.mergeSha = merge.sha;

  // Best-effort branch cleanup — failures here don't fail the node.
  if ((config.deleteBranch ?? true) && job.branchName) {
    await ghApi(fetchFn, cred, 'DELETE', `/repos/${ref.owner}/${ref.name}/git/refs/heads/${job.branchName}`, undefined).catch(
      () => {},
    );
  }

  return {
    lastExit: { nodeId, kind: 'success' },
    output: JSON.stringify({ mergeSha: merge.sha, prNumber: ref.number }),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pickRepo(configured: string | undefined, job: JobRecord): string | null {
  if (configured) return configured;
  const repos = job.productRepos ?? [];
  return repos.length === 1 ? repos[0]! : null;
}

function isHttpsRemote(url: string): boolean {
  return url.startsWith('https://');
}

/** Parse `owner/name` from an SSH (`git@github.com:owner/name.git`) or
 *  HTTPS (`https://github.com/owner/name(.git)`) remote URL. */
function parseRepoSlug(url: string): { owner: string; name: string } | null {
  const ssh = url.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1]!, name: ssh[2]! };
  const https = url.match(/^https:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (https) return { owner: https[1]!, name: https[2]! };
  return null;
}

/** Parse `{owner, name, number}` from a PR HTML URL like
 *  `https://github.com/owner/name/pull/123`. */
function parsePrUrl(url: string): { owner: string; name: string; number: number } | null {
  const m = url.match(/^https:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1]!, name: m[2]!, number: Number(m[3]) };
}

async function getDefaultBranch(
  slug: { owner: string; name: string },
  cred: GitHubCredential,
  fetchFn: typeof fetch,
): Promise<string> {
  const repo = await ghApi<{ default_branch: string }>(fetchFn, cred, 'GET', `/repos/${slug.owner}/${slug.name}`, undefined);
  return repo.default_branch || 'main';
}

function defaultPrTitle(job: JobRecord): string {
  return job.name ? job.name : `agentx job ${job.jobId}`;
}

function defaultPrBody(job: JobRecord, base: string, cred: GitHubCredential): string {
  const actor = cred.actor ? ` (as ${cred.actor})` : '';
  return [
    `Opened by agentx job \`${job.jobId}\`${actor}.`,
    '',
    `- base: \`${base}\``,
    job.input ? `- intent: ${truncate(String(job.input), 500)}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

async function ghApi<T>(
  fetchFn: typeof fetch,
  cred: GitHubCredential,
  method: string,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetchFn(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cred.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub ${method} ${path} → ${res.status} ${res.statusText}${text ? `: ${truncate(text, 300)}` : ''}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('close', (code) => {
      if (code !== 0) {
        rejectP(new Error(`git ${args.join(' ')} (in ${cwd}) exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolveP(stdout);
    });
    child.on('error', rejectP);
  });
}

function err(nodeId: string, errorName: string, errorMessage: string): NodeDelta {
  return { lastExit: { nodeId, kind: 'error' as const, errorName, errorMessage } };
}

/**
 * Gate 2 — end-to-end: open a PR against a real GitHub repo, pause for
 * HITL approval, then merge it. Zero hand-edits.
 *
 * Flow exercised: `[__trigger] → [push-and-open-pr] → [merge-pr (tagged
 * approval)]`. The "agent's work" is stubbed by a direct commit into the
 * per-job worktree (this example proves the *delivery* path — publish
 * nodes + approval gate + merge — not the LLM step).
 *
 * What it does:
 *   1. `spawnWorker` → bare clone + per-job worktree on a fresh branch.
 *   2. Writes a trivial file into the worktree, `git add` + `git commit`.
 *   3. `runJob` with a FlowDef whose only nodes are the trigger and two
 *      `publish` nodes; the `merge-pr` node is tagged `approval`.
 *      - push-and-open-pr: pushes the branch, opens a PR via the GitHub
 *        REST API (creds from `defaultGitHubResolver()` → local `gh`),
 *        records `job.branchName` + `job.prUrl`.
 *      - the synthetic approval node pauses the graph.
 *   4. `resumeJob({ decision: 'approve' })` → the graph ticks into
 *      `merge-pr` → merges the PR, records `job.mergeSha`.
 *   5. Asserts `job.prUrl` and `job.mergeSha` are set; prints them.
 *
 * Prerequisites:
 *   - `gh auth login` done locally (the LocalAmbient resolver shells out
 *     to `gh auth token`), with push + PR + merge rights on the target
 *     repo.
 *   - SSH agent loaded if the repo is cloned via SSH (default below).
 *   - A LOW-STAKES target repo — this opens AND merges a real PR.
 *     Override with `GATE2_REPO_URL` / `GATE2_PRODUCT_ID`.
 *
 * Cleanup: deletes the temp workspace at exit. The merged PR + the
 * commit on the default branch are NOT reverted — pick a sandbox repo.
 *
 * Run:  GATE2_REPO_URL=git@github.com:you/sandbox.git \
 *       pnpm --filter @ecruz165/harness exec tsx examples/20-gate2-pr-merge-e2e.ts
 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultGitHubResolver } from '@ecruz165/agent-auth';
import type { CredentialBroker } from '@ecruz165/agent-auth';
import {
  type CompiledFlowGraph,
  type FlowDef,
  type JobRecord,
  JobBus,
  resumeJob,
  runJob,
} from '@ecruz165/harness-core';
import { spawnWorker } from '@ecruz165/harness-server';

const REPO_URL = process.env.GATE2_REPO_URL ?? 'git@github.com:jefelabs/agentx-sandbox.git';
const PRODUCT_ID = process.env.GATE2_PRODUCT_ID ?? 'agentx-sandbox';
const REPO_NAME = repoNameFromUrl(REPO_URL);

console.log('=== Gate 2 E2E: open PR → approve → merge ===');
console.log(`Repo:        ${REPO_URL}`);
console.log(`Product:     ${PRODUCT_ID}`);
console.log(`gh auth:     run \`gh auth status\` if the resolver step fails`);
console.log(`SSH agent:   ${process.env.SSH_AUTH_SOCK ? 'loaded' : 'not loaded'}`);
console.log('');

const wsRoot = await mkdtemp(join(tmpdir(), 'agentx-gate2-'));
const jobId = `gate2_${randomUUID().slice(0, 8)}`;

try {
  // ── 1. spawnWorker: bare clone + per-job worktree on a fresh branch ──────
  console.log(`[1] spawnWorker (jobId=${jobId})…`);
  const spawn1 = await spawnWorker({
    jobId,
    productId: PRODUCT_ID,
    pipeline: 'gate2-e2e',
    workspaceRoot: wsRoot,
    repos: [{ name: REPO_NAME, cloneUrl: REPO_URL, path: `/workspace/${REPO_NAME}` }],
    forwardSshAgent: !!process.env.SSH_AUTH_SOCK,
  });
  const wt = spawn1.worktrees.find((w) => w.repo === REPO_NAME);
  if (!wt) throw new Error(`no worktree for ${REPO_NAME} in spawn result`);
  console.log(`    worktree: ${wt.path}`);
  console.log(`    branch:   ${wt.branch}`);
  console.log(`    baseRef:  ${wt.baseRef ?? '(none)'}\n`);

  // ── 2. Stand in for the agent: make a trivial commit in the worktree ─────
  console.log('[2] committing a trivial change in the worktree…');
  const marker = `agentx gate-2 e2e — ${new Date().toISOString()}\n`;
  await writeFile(join(wt.path, '.agentx-gate2-marker'), marker, 'utf8');
  await git(wt.path, ['add', '.agentx-gate2-marker']);
  await git(wt.path, ['-c', 'user.email=agentx@example.com', '-c', 'user.name=agentx', 'commit', '-m', `chore: gate-2 e2e marker (${jobId})`]);
  console.log('    committed.\n');

  // ── 3. Build the flow + JobRecord and run it ─────────────────────────────
  const flow: FlowDef = {
    id: 'gate2-e2e',
    nodes: [
      { id: '__trigger', kind: 'trigger', config: { kind: 'manual' } },
      { id: 'open-pr', kind: 'publish', config: { action: 'push-and-open-pr', title: `agentx gate-2 e2e (${jobId})` } },
      {
        id: 'merge',
        kind: 'publish',
        config: { action: 'merge-pr', method: 'squash' },
        tags: { approval: { assigneeRole: 'reviewer', slaMs: 600_000, concurrency: 'pessimistic' } },
      },
    ],
    edges: [
      { from: '__trigger', to: 'open-pr', type: 'sequence' },
      { from: 'open-pr', to: 'merge', type: 'sequence' },
    ],
  };

  const jobs = new Map<string, JobRecord>();
  const bus = new JobBus();
  const graphs = new Map<string, CompiledFlowGraph>();
  const job: JobRecord = {
    jobId,
    pipeline: 'gate2-e2e',
    productId: PRODUCT_ID,
    productRepos: [REPO_NAME],
    status: 'received',
    submittedAt: new Date().toISOString(),
    input: 'gate-2 e2e',
    // The publish executor reads the worktree at `${workdirRoot}/${repo}`.
    // spawnWorker put it at <ws>/.harness/wt/<jobId>/<subagentId>/<repo>,
    // so workdirRoot is that path's parent.
    workdirRoot: dirname(wt.path),
    flow,
    agents: [],
  };
  jobs.set(jobId, job);

  const broker: CredentialBroker = {
    async getCredential(provider) {
      return { provider, apiKey: 'unused-no-llm-in-this-flow', source: 'env' };
    },
  };
  const githubResolver = defaultGitHubResolver({
    ...(process.env.CONTROLPLANE_URL ? { controlplaneUrl: process.env.CONTROLPLANE_URL } : {}),
  });

  console.log('[3] runJob → push branch + open PR, then pause for approval…');
  await runJob(jobId, {
    jobs,
    bus,
    broker,
    githubResolver,
    graphs,
    onAwaitingApproval: (_jid, req) => {
      console.log(`    paused: assignee=${req.assigneeRole} prUrl=${req.prUrl ?? '(none)'} diff=${req.diffSummary ?? '(none)'}`);
    },
  });
  const statusAfterRun: string = job.status;
  if (statusAfterRun !== 'awaiting-approval') {
    throw new Error(`expected job to pause at approval, got status=${statusAfterRun}`);
  }
  if (!job.prUrl) throw new Error('push-and-open-pr did not record job.prUrl');
  console.log(`    PR opened: ${job.prUrl}`);
  console.log(`    branch:    ${job.branchName}\n`);

  // ── 4. Approve → graph resumes → merge-pr runs ───────────────────────────
  console.log('[4] resumeJob({ decision: "approve" }) → merge…');
  await resumeJob(jobId, { decision: 'approve' }, { jobs, bus, broker, githubResolver, graphs });
  const statusAfterResume: string = job.status;
  if (statusAfterResume !== 'completed') {
    throw new Error(`expected job to complete after approve, got status=${statusAfterResume} (failureReason=${String(job.failureReason ?? '')})`);
  }
  if (!job.mergeSha) throw new Error('merge-pr did not record job.mergeSha');

  // ── 5. Assertions ────────────────────────────────────────────────────────
  console.log('\n=== PASS ===');
  console.log(`prUrl:    ${job.prUrl}`);
  console.log(`branch:   ${job.branchName}`);
  console.log(`mergeSha: ${job.mergeSha}`);
} finally {
  await rm(wsRoot, { recursive: true, force: true }).catch(() => {});
  console.log(`\n(cleaned up temp workspace ${wsRoot})`);
}

function repoNameFromUrl(url: string): string {
  const m = url.match(/[/:]([^/]+?)(?:\.git)?$/);
  return m ? m[1]! : 'repo';
}

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('close', (code) => (code === 0 ? resolveP() : rejectP(new Error(`git ${args.join(' ')} → ${code}: ${stderr.trim()}`))));
    child.on('error', rejectP);
  });
}

/**
 * Unit tests for the `kind: 'publish'` executor.
 *
 * Covers the pre-flight error paths that don't touch `git` or the
 * network — credential wiring, repo selection, and PR-URL parsing. The
 * happy paths (real `git push` + GitHub REST round-trips) are exercised
 * by the Gate 2d E2E test against a live repo, not here.
 */

import { describe, expect, it } from 'vitest';
import type { GitHubCredential, GitHubCredentialResolver } from '@ecruz165/agent-auth';
import type { TaskStep } from './catalog.ts';
import { FlowState, type FlowStateT } from './flow-graph.ts';
import type { JobRecord } from './job.ts';
import { makePublishExecutor } from './publish-executor.ts';

const STUB_RESOLVER: GitHubCredentialResolver = {
  resolve: async (): Promise<GitHubCredential | null> => ({ token: 'tok', source: 'local-gh-cli' }),
};

function freshState(jobId: string): FlowStateT {
  void FlowState;
  return {
    jobId,
    output: '',
    messages: [],
    attempts: {},
    lastExit: null,
    rejectionPayload: null,
    steering: [],
    cancelRequested: false,
    cancelReason: null,
    changedFiles: [],
  } as FlowStateT;
}

function pushNode(config: Record<string, unknown>): TaskStep {
  return { id: 'pub', kind: 'publish', config: { action: 'push-and-open-pr', ...config } } as TaskStep;
}
function mergeNode(config: Record<string, unknown> = {}): TaskStep {
  return { id: 'mrg', kind: 'publish', config: { action: 'merge-pr', ...config } } as TaskStep;
}
function job(over: Partial<JobRecord>): JobRecord {
  return {
    jobId: 'job_test',
    submittedAt: new Date().toISOString(),
    status: 'running',
    agents: [],
    ...over,
  } as JobRecord;
}

describe('makePublishExecutor', () => {
  it('fails with UnconfiguredGitHub when no resolver is supplied', async () => {
    const run = makePublishExecutor(pushNode({}), { job: job({}) });
    const delta = await run(freshState('job_test'));
    expect(delta.lastExit).toMatchObject({ kind: 'error', errorName: 'UnconfiguredGitHub' });
  });

  it('throws if given a non-publish node', () => {
    const bad = { id: 'x', kind: 'tool', config: { toolId: 't' } } as unknown as TaskStep;
    expect(() => makePublishExecutor(bad, { job: job({}) })).toThrow(/expected "publish"/);
  });

  describe('push-and-open-pr', () => {
    it('fails with AmbiguousRepo when product has multiple repos and no config.repo', async () => {
      const run = makePublishExecutor(pushNode({}), {
        job: job({ productRepos: ['a', 'b'], workdirRoot: '/tmp/ws' }),
        githubResolver: STUB_RESOLVER,
      });
      const delta = await run(freshState('job_test'));
      expect(delta.lastExit).toMatchObject({ kind: 'error', errorName: 'AmbiguousRepo' });
    });

    it('fails with NoWorkdir when workdirRoot is unset', async () => {
      const run = makePublishExecutor(pushNode({ repo: 'a' }), {
        job: job({ productRepos: ['a'] }),
        githubResolver: STUB_RESOLVER,
      });
      const delta = await run(freshState('job_test'));
      expect(delta.lastExit).toMatchObject({ kind: 'error', errorName: 'NoWorkdir' });
    });
  });

  describe('merge-pr', () => {
    it('fails with NoPr when JobRecord.prUrl is unset', async () => {
      const run = makePublishExecutor(mergeNode(), { job: job({}), githubResolver: STUB_RESOLVER });
      const delta = await run(freshState('job_test'));
      expect(delta.lastExit).toMatchObject({ kind: 'error', errorName: 'NoPr' });
    });

    it('fails with UnparseablePrUrl when prUrl is not a recognisable PR URL', async () => {
      const run = makePublishExecutor(mergeNode(), {
        job: job({ prUrl: 'https://example.com/not-a-pr' }),
        githubResolver: STUB_RESOLVER,
      });
      const delta = await run(freshState('job_test'));
      expect(delta.lastExit).toMatchObject({ kind: 'error', errorName: 'UnparseablePrUrl' });
    });
  });
});

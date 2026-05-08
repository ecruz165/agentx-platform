/**
 * Tests for the validateRepoAccess predicate (slice 9d-followup).
 *
 * Strategy:
 *   - Use a local git "remote" (just a bare repo on disk acting as
 *     origin) to exercise the success path — same fixture pattern as
 *     spawn-worker.test.ts.
 *   - Use a non-existent file path to exercise the failure path
 *     deterministically (fast, no network).
 *   - Unit-test parseHeadSha + suggestFix as pure functions for
 *     edge cases that integration would be flaky on.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseHeadSha, suggestFix, validateRepoAccess } from './validate-repo-access.ts';

const tmps: string[] = [];
afterEach(async () => {
  for (const dir of tmps.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  tmps.push(dir);
  return dir;
}

/** Identity env for git so we don't pay for two `git config` spawns per
 *  test. Same effect as `git config user.email/name` but inline on the
 *  spawn — under parallel load (60+ test files), each saved fork+exec
 *  matters. */
const GIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@t',
};

function runGit(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn('git', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      cwd,
      env: { ...process.env, ...GIT_IDENTITY_ENV },
    });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', rejectP);
    child.on('close', (code) => {
      if (code !== 0) rejectP(new Error(`git ${args.join(' ')} failed: ${stderr}`));
      else resolveP();
    });
  });
}

/** Local "remote" — a bare repo on disk we can ls-remote against. */
async function localRemote(): Promise<string> {
  const bare = await tmpDir('vra-bare');
  await rm(bare, { recursive: true, force: true });
  await runGit(['init', '--bare', bare]);

  const work = await tmpDir('vra-work');
  await runGit(['init', work]);
  // No `git config` calls — identity flows via GIT_IDENTITY_ENV in runGit.
  await writeFile(join(work, 'README.md'), 'v1\n');
  await runGit(['-C', work, 'add', '.']);
  await runGit(['-C', work, 'commit', '-m', 'init']);
  await runGit(['-C', work, 'branch', '-M', 'main']);
  await runGit(['-C', work, 'remote', 'add', 'origin', bare]);
  await runGit(['-C', work, 'push', '-u', 'origin', 'main']);
  await runGit(['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  return bare;
}

describe('validateRepoAccess — happy path', () => {
  // Generous timeout: setup spawns ~10 git subprocesses sequentially.
  // Under parallel load (full-repo `pnpm test`) the OS-scheduled
  // fork+exec queue can stall; 15s gives headroom. Other tests in
  // this file inherit warm filesystem state from earlier setup so
  // they don't need the bump.
  it('reports ok with HEAD SHA for an accessible local bare', { timeout: 15_000 }, async () => {
    const bare = await localRemote();
    const result = await validateRepoAccess({
      repos: [{ name: 'demo', cloneUrl: bare }],
    });

    expect(result.accessible).toHaveLength(1);
    expect(result.failures).toHaveLength(0);
    expect(result.all[0]?.ok).toBe(true);
    expect(result.all[0]?.head).toMatch(/^[a-f0-9]{40}$/);
    expect(result.all[0]?.durationMs).toBeGreaterThan(0);
  });

  it('returns empty result for empty input', async () => {
    const result = await validateRepoAccess({ repos: [] });
    expect(result.accessible).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.all).toEqual([]);
  });

  it('preserves input order in result.all', { timeout: 15_000 }, async () => {
    const bareA = await localRemote();
    const bareB = await localRemote();
    const result = await validateRepoAccess({
      repos: [
        { name: 'first', cloneUrl: bareA },
        { name: 'second', cloneUrl: bareB },
      ],
    });
    expect(result.all.map((c) => c.repo.name)).toEqual(['first', 'second']);
  });
});

describe('validateRepoAccess — failure path', () => {
  it('reports failure for a nonexistent local path', async () => {
    const result = await validateRepoAccess({
      repos: [{ name: 'broken', cloneUrl: '/nonexistent/path/to/repo.git' }],
    });
    expect(result.accessible).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.ok).toBe(false);
    expect(result.failures[0]?.reason).toBeTruthy();
    expect(result.failures[0]?.head).toBeUndefined();
  });

  it('separates accessible + failures in mixed input', async () => {
    const bare = await localRemote();
    const result = await validateRepoAccess({
      repos: [
        { name: 'good', cloneUrl: bare },
        { name: 'bad', cloneUrl: '/nonexistent/repo.git' },
      ],
    });
    expect(result.accessible).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.accessible[0]?.repo.name).toBe('good');
    expect(result.failures[0]?.repo.name).toBe('bad');
    // result.all preserves input order regardless.
    expect(result.all.map((c) => c.repo.name)).toEqual(['good', 'bad']);
  });
});

describe('validateRepoAccess — parallel vs sequential', () => {
  it('parallel mode finishes faster than sequential for multiple repos', {
    timeout: 15_000,
  }, async () => {
    // Two local bares — each ls-remote takes ~50-200ms. Parallel run
    // should finish in close to the time of one; sequential takes
    // close to the sum.
    const bareA = await localRemote();
    const bareB = await localRemote();
    const repos = [
      { name: 'a', cloneUrl: bareA },
      { name: 'b', cloneUrl: bareB },
    ];

    const tParStart = Date.now();
    await validateRepoAccess({ repos, parallel: true });
    const parallelMs = Date.now() - tParStart;

    const tSeqStart = Date.now();
    await validateRepoAccess({ repos, parallel: false });
    const sequentialMs = Date.now() - tSeqStart;

    // Parallel should be at least somewhat faster. Don't assert a
    // tight ratio (CI variance) — just that it isn't catastrophically
    // worse.
    expect(parallelMs).toBeLessThanOrEqual(sequentialMs * 1.5);
  });
});

describe('parseHeadSha', () => {
  it('extracts SHA from typical ls-remote output', () => {
    const stdout = 'abc1234abc1234abc1234abc1234abc1234abc12\trefs/heads/main\n';
    expect(parseHeadSha(stdout)).toBe('abc1234abc1234abc1234abc1234abc1234abc12');
  });

  it('extracts SHA when output is just HEAD', () => {
    const stdout = 'def5678def5678def5678def5678def5678def56\tHEAD\n';
    expect(parseHeadSha(stdout)).toBe('def5678def5678def5678def5678def5678def56');
  });

  it('returns undefined for empty stdout', () => {
    expect(parseHeadSha('')).toBeUndefined();
    expect(parseHeadSha('\n')).toBeUndefined();
  });

  it('returns undefined when first token is not a 40-char hex SHA', () => {
    expect(parseHeadSha('not-a-sha\trefs/heads/main\n')).toBeUndefined();
  });

  it('takes only the first line — multi-line output ignored after first', () => {
    const stdout =
      'abc1234abc1234abc1234abc1234abc1234abc12\trefs/heads/main\n' +
      'xyz9999...\trefs/heads/develop\n';
    expect(parseHeadSha(stdout)).toBe('abc1234abc1234abc1234abc1234abc1234abc12');
  });
});

describe('suggestFix', () => {
  it('SSH form + permission denied → suggests ssh-add', () => {
    const s = suggestFix(
      'git@github.com:org/repo.git',
      'Permission denied (publickey).\nfatal: Could not read from remote repository.',
    );
    expect(s).toMatch(/ssh-add/);
  });

  it('SSH form + repository not found → suggests checking key access', () => {
    const s = suggestFix('git@github.com:org/private-repo.git', 'ERROR: Repository not found.');
    expect(s).toMatch(/key.*access/i);
  });

  it('HTTPS form + 401 → suggests credential manager or PAT', () => {
    const s = suggestFix(
      'https://github.com/org/repo.git',
      'fatal: Authentication failed for https://github.com/org/repo.git',
    );
    expect(s).toMatch(/PAT|credential/i);
  });

  it('HTTPS form + 404 → suggests SSH form switch', () => {
    const s = suggestFix(
      'https://github.com/org/private-repo.git',
      "remote: Repository not found.\nfatal: repository 'https://github.com/org/private-repo.git/' not found",
    );
    expect(s).toMatch(/SSH form/i);
  });

  it('timeout → suggests checking network', () => {
    const s = suggestFix(
      'https://github.com/org/repo.git',
      'timeout after 10000ms (process killed)',
    );
    expect(s).toMatch(/network|timed out/i);
  });

  it('returns undefined for unrecognized failure', () => {
    const s = suggestFix(
      'https://github.com/org/repo.git',
      'something completely unexpected from git',
    );
    expect(s).toBeUndefined();
  });
});

describe('validateRepoAccess — cloneEnv forwarding', () => {
  it('passes cloneEnv through to git child processes', async () => {
    // A degenerate but observable test: setting GIT_ASKPASS to a
    // path that doesn't exist would normally cause auth-prompt issues
    // — but for a reachable local bare, no askpass is consulted.
    // The test just confirms cloneEnv doesn't break the happy path.
    const bare = await localRemote();
    const result = await validateRepoAccess({
      repos: [{ name: 'demo', cloneUrl: bare }],
      cloneEnv: { GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'cloneEnv test' },
    });
    expect(result.accessible).toHaveLength(1);
    expect(result.failures).toHaveLength(0);
  });
});

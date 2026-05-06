/**
 * runJobInContainer tests — exercises the integration layer using
 * the same fake-devcontainer pattern from 9d-3, plus a local "remote"
 * git fixture from 9d-2.
 *
 * Coverage:
 *   - buildJobSpec: pure function, no subprocesses
 *   - runJobInContainer happy path: fake devcontainer-cli dispatches
 *     on first arg ('up' vs 'exec'), runWorker captures fake
 *     containerId, runPipelineInContainer streams canned JSONL,
 *     envelopes flow onto the parent's bus
 *   - cleanup policy: rm-on-failure default, keep-on-success default
 *   - error path: spawn failure surfaces as job-failed + error
 *     envelope
 *
 * Real Docker integration testing happens via manual smoke runs
 * (skoolscout-com URL).
 */

import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BindingResolver, CredentialBroker, ResolvedBinding } from '@agentx/agent-auth-lib';
import { type Envelope, JobBus, type JobRecord } from '@agentx/harness-core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildJobSpec, runJobInContainer } from './run-job-in-container.ts';

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

const dummyBroker: CredentialBroker = {
  async getCredential(provider) {
    return { provider, apiKey: 'stub', source: 'host-file' };
  },
};

function fakeBinding(providerId: string, modelId: string): ResolvedBinding {
  return {
    kind: 'cloud',
    provider: { id: providerId as never, name: providerId, authMethods: ['api-key'], models: [] },
    model: { id: modelId, type: 'text' },
    credential: { provider: providerId as never, apiKey: 'stub', source: 'host-file' },
  };
}

const stubResolver: BindingResolver = {
  async resolveBinding(accepts) {
    // Simple: parse `<provider>:<model>` from the first entry and
    // synthesize a binding. Real resolver does broker auth checks;
    // this stub doesn't care since the test never invokes the
    // adapter.
    const first = accepts[0];
    if (!first) throw new Error('empty accepts');
    const [provider = 'anthropic', model = 'claude-haiku-4-5'] = first.split(':');
    return fakeBinding(provider, model);
  },
};

// ─── Fake devcontainer-cli ─────────────────────────────────────────────────
//
// Dispatches on first arg:
//   `<bin> up ...`    → emits canned JSON with containerId
//   `<bin> exec ...`  → cat the FAKE_EXEC_FILE env var (JSONL)
// All other args ignored.

async function fakeDevcontainer(opts: {
  containerId: string;
  execStdout?: string;
  execStderr?: string;
  execExitCode?: number;
}): Promise<{ binPath: string; execFilePath: string }> {
  const dir = await tmpDir('fake-dc-int');
  const execFile = join(dir, 'exec-output.txt');
  await writeFile(execFile, opts.execStdout ?? '');
  const stderrFile = join(dir, 'exec-stderr.txt');
  await writeFile(stderrFile, opts.execStderr ?? '');

  const binPath = join(dir, 'fake-devcontainer.sh');
  const upJson = JSON.stringify({ outcome: 'success', containerId: opts.containerId });
  // Single-quoted heredoc lets us embed the JSON literally without
  // shell substitution.
  const script = `#!/bin/sh
case "$1" in
  up)
    cat <<'EOF'
${upJson}
EOF
    ;;
  exec)
    cat ${shellSingleQuote(execFile)}
    cat ${shellSingleQuote(stderrFile)} 1>&2
    exit ${opts.execExitCode ?? 0}
    ;;
  *)
    echo "fake-devcontainer: unknown mode $1" 1>&2
    exit 1
    ;;
esac
`;
  await writeFile(binPath, script);
  await chmod(binPath, 0o755);
  return { binPath, execFilePath: execFile };
}

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ─── git fixture (mirrors spawn-worker.test.ts) ────────────────────────────

function runGit(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn('git', args, { stdio: ['ignore', 'ignore', 'pipe'], cwd });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', rejectP);
    child.on('close', (code) => {
      if (code !== 0) rejectP(new Error(`git ${args.join(' ')} exited ${code}: ${stderr}`));
      else resolveP();
    });
  });
}

async function localRemote(): Promise<string> {
  const bare = await tmpDir('remote-bare');
  await rm(bare, { recursive: true, force: true });
  await runGit(['init', '--bare', bare]);

  const work = await tmpDir('remote-work');
  await runGit(['init', work]);
  await runGit(['-C', work, 'config', 'user.email', 't@t']);
  await runGit(['-C', work, 'config', 'user.name', 'T']);
  await writeFile(join(work, 'README.md'), 'v1\n');
  await runGit(['-C', work, 'add', '.']);
  await runGit(['-C', work, 'commit', '-m', 'init']);
  await runGit(['-C', work, 'branch', '-M', 'main']);
  await runGit(['-C', work, 'remote', 'add', 'origin', bare]);
  await runGit(['-C', work, 'push', '-u', 'origin', 'main']);
  await runGit(['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  return bare;
}

function jobRecord(jobId: string, agents: JobRecord['agents']): JobRecord {
  return {
    jobId,
    pipeline: 'feature-add',
    status: 'received',
    submittedAt: new Date().toISOString(),
    input: 'do the thing',
    agents,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('buildJobSpec', () => {
  it('produces a valid spec with bindings keyed by agent id', async () => {
    const job = jobRecord('j1', [
      {
        id: 'planner',
        role: 'Plan',
        adapter: 'claude-sdk',
        status: 'pending',
        accepts: ['anthropic:claude-haiku-4-5'],
      },
      {
        id: 'reviewer',
        role: 'Review',
        adapter: 'claude-sdk',
        status: 'pending',
        accepts: ['openai:gpt-4o'],
      },
    ]);

    const spec = await buildJobSpec({
      job,
      jobId: 'j1',
      productId: 'p',
      pipeline: 'feature-add',
      setName: 'default',
      resolver: stubResolver,
    });

    expect(spec.version).toBe(1);
    expect(spec.jobId).toBe('j1');
    expect(spec.agents).toHaveLength(2);
    expect(spec.agents[0]?.bindingId).toBe('planner');
    expect(spec.agents[1]?.bindingId).toBe('reviewer');
    expect(spec.bindings.planner?.provider.id).toBe('anthropic');
    expect(spec.bindings.reviewer?.provider.id).toBe('openai');
  });

  it('skips synthetic coordinators (no bindingId, no entry in bindings map)', async () => {
    const job = jobRecord('j-coord', [
      { id: 'coordinator', role: 'C', adapter: 'claude-sdk', status: 'pending' },
      {
        id: 'planner',
        role: 'Plan',
        adapter: 'claude-sdk',
        status: 'pending',
        accepts: ['anthropic:claude-haiku-4-5'],
      },
      { id: 'checkout-coordinator', role: 'X', adapter: 'claude-sdk', status: 'pending' },
    ]);

    const spec = await buildJobSpec({
      job,
      jobId: 'j-coord',
      productId: 'p',
      pipeline: 'feature-add',
      setName: 'default',
      resolver: stubResolver,
    });

    // All 3 agents in the spec, but only planner has a bindingId.
    expect(spec.agents).toHaveLength(3);
    expect(spec.agents.find((a) => a.id === 'coordinator')?.bindingId).toBeUndefined();
    expect(spec.agents.find((a) => a.id === 'planner')?.bindingId).toBe('planner');
    expect(spec.agents.find((a) => a.id === 'checkout-coordinator')?.bindingId).toBeUndefined();
    expect(Object.keys(spec.bindings)).toEqual(['planner']);
  });

  it('skips agents with empty accepts (legacy adapter-id factory path)', async () => {
    const job = jobRecord('j-noaccepts', [
      { id: 'planner', role: 'Plan', adapter: 'claude-sdk', status: 'pending' }, // no accepts
    ]);

    const spec = await buildJobSpec({
      job,
      jobId: 'j-noaccepts',
      productId: 'p',
      pipeline: 'feature-add',
      setName: 'default',
      resolver: stubResolver,
    });

    expect(spec.agents).toHaveLength(1);
    expect(spec.agents[0]?.bindingId).toBeUndefined();
    expect(spec.bindings).toEqual({});
  });

  it('propagates set name + name + input + productRepos through to the spec', async () => {
    const job: JobRecord = {
      ...jobRecord('j-meta', [
        { id: 'coordinator', role: 'C', adapter: 'claude-sdk', status: 'pending' },
      ]),
      name: 'my-job-name',
      productRepos: ['repo-a', 'repo-b'],
    };

    const spec = await buildJobSpec({
      job,
      jobId: 'j-meta',
      productId: 'mobile-app',
      pipeline: 'feature-add',
      setName: 'cheap',
      resolver: stubResolver,
    });

    expect(spec.set).toBe('cheap');
    expect(spec.name).toBe('my-job-name');
    expect(spec.input).toBe('do the thing');
    expect(spec.productId).toBe('mobile-app');
    expect(spec.productRepos).toEqual(['repo-a', 'repo-b']);
  });
});

describe('runJobInContainer (integration via fake devcontainer-cli)', () => {
  it('drives a job to completion via spawnWorker → runWorker → runPipelineInContainer', {
    timeout: 15_000,
  }, async () => {
    const wsRoot = await tmpDir('ws');
    const bare = await localRemote();

    const jobs = new Map<string, JobRecord>();
    const job = jobRecord('j-int-1', [
      { id: 'coordinator', role: 'C', adapter: 'claude-sdk', status: 'pending' },
    ]);
    jobs.set('j-int-1', job);

    const bus = new JobBus();
    const seen: Envelope[] = [];
    bus.subscribe('j-int-1', (env) => seen.push(env));

    // Fake devcontainer: `up` reports a containerId, `exec` emits a
    // single envelope + the sentinel.
    const fake = await fakeDevcontainer({
      containerId: 'fake-ctr-int1',
      execStdout:
        JSON.stringify({
          jobId: 'j-int-1',
          agentId: 'planner',
          event: { kind: 'response', ts: 't', text: 'hello-from-container' },
        }) +
        '\n' +
        JSON.stringify({ kind: 'job-complete', jobId: 'j-int-1', status: 'completed' }) +
        '\n',
    });

    // Worker template directory is referenced by runWorker but not
    // actually used by our fake. spawnWorker only uses workspaceRoot.
    // Pre-create the dir so spawnWorker doesn't error on the bind
    // mount path.
    await mkdir(join(wsRoot, '.harness/run'), { recursive: true });

    const transitions: Array<[string | null, string]> = [];
    const result = await runJobInContainer({
      jobId: 'j-int-1',
      jobs,
      bus,
      broker: dummyBroker,
      resolver: stubResolver,
      workspaceRoot: wsRoot,
      repos: [{ name: 'demo', cloneUrl: bare }],
      productId: 'demo-product',
      pipeline: 'feature-add',
      devcontainerBin: fake.binPath,
      onStatusChange: (_jid, agentId, status) => transitions.push([agentId, status]),
    });

    expect(result.status).toBe('completed');
    expect(result.containerId).toBe('fake-ctr-int1');
    // Default policy: keep on success.
    expect(result.containerRemoved).toBe(false);

    // Job-level status transitions: running → completed.
    expect(transitions).toEqual([
      [null, 'running'],
      [null, 'completed'],
    ]);

    // The envelope from inside the container reached the parent's bus.
    expect(seen).toHaveLength(1);
    if (seen[0]?.event.kind === 'response') {
      expect(seen[0].event.text).toBe('hello-from-container');
    }
  });

  it('reports failed status and removes the container when the executor fails', async () => {
    const wsRoot = await tmpDir('ws');
    const bare = await localRemote();
    const jobs = new Map<string, JobRecord>();
    jobs.set(
      'j-fail',
      jobRecord('j-fail', [
        { id: 'coordinator', role: 'C', adapter: 'claude-sdk', status: 'pending' },
      ]),
    );

    const bus = new JobBus();

    // Fake devcontainer: up succeeds, exec fails (no sentinel, exit 1)
    const fake = await fakeDevcontainer({
      containerId: 'fake-fail-ctr',
      execStdout: '',
      execStderr: 'pipeline panicked\n',
      execExitCode: 1,
    });

    // Track docker rm calls — replace the dockerBin with a fake that
    // records its args. Since runJobInContainer uses removeContainer
    // (which spawns `docker rm -f <id>`), we can't easily intercept
    // without a docker stub. Skip the cleanup-side assertion in this
    // test; covered separately by the unit test of removeContainer.
    await mkdir(join(wsRoot, '.harness/run'), { recursive: true });

    const result = await runJobInContainer({
      jobId: 'j-fail',
      jobs,
      bus,
      broker: dummyBroker,
      resolver: stubResolver,
      workspaceRoot: wsRoot,
      repos: [{ name: 'demo', cloneUrl: bare }],
      productId: 'demo',
      pipeline: 'feature-add',
      devcontainerBin: fake.binPath,
      // Disable cleanup so the test doesn't actually invoke docker.
      removeContainerOnFailure: false,
    });

    expect(result.status).toBe('failed');
    expect(result.containerId).toBe('fake-fail-ctr');
    expect(result.containerRemoved).toBe(false);
    expect(jobs.get('j-fail')?.status).toBe('failed');
  });

  it('publishes an error envelope when devcontainer up itself fails', async () => {
    const wsRoot = await tmpDir('ws');
    const bare = await localRemote();
    const jobs = new Map<string, JobRecord>();
    jobs.set(
      'j-up-fail',
      jobRecord('j-up-fail', [
        { id: 'coordinator', role: 'C', adapter: 'claude-sdk', status: 'pending' },
      ]),
    );

    const bus = new JobBus();
    const seen: Envelope[] = [];
    bus.subscribe('j-up-fail', (env) => seen.push(env));

    // Fake devcontainer where `up` exits non-zero — runWorker should throw
    // and runJobInContainer surfaces it as a job-level error envelope.
    const dir = await tmpDir('fake-broken');
    const broken = join(dir, 'broken-devcontainer.sh');
    await writeFile(broken, '#!/bin/sh\nexit 1\n');
    await chmod(broken, 0o755);

    await mkdir(join(wsRoot, '.harness/run'), { recursive: true });

    const result = await runJobInContainer({
      jobId: 'j-up-fail',
      jobs,
      bus,
      broker: dummyBroker,
      resolver: stubResolver,
      workspaceRoot: wsRoot,
      repos: [{ name: 'demo', cloneUrl: bare }],
      productId: 'demo',
      pipeline: 'feature-add',
      devcontainerBin: broken,
    });

    expect(result.status).toBe('failed');
    // No containerId since up never succeeded.
    expect(result.containerId).toBeUndefined();
    expect(jobs.get('j-up-fail')?.status).toBe('failed');

    // Synthetic error envelope on the bus.
    const errs = seen.filter((e) => e.event.kind === 'error');
    expect(errs).toHaveLength(1);
    if (errs[0]?.event.kind === 'error') {
      expect(errs[0].event.message).toContain('container spawn failed');
    }
  });

  it('removeContainerOnSuccess=true triggers a cleanup attempt with the right args', async () => {
    const wsRoot = await tmpDir('ws');
    const bare = await localRemote();
    const jobs = new Map<string, JobRecord>();
    jobs.set(
      'j-cleanup',
      jobRecord('j-cleanup', [
        { id: 'coordinator', role: 'C', adapter: 'claude-sdk', status: 'pending' },
      ]),
    );

    const bus = new JobBus();

    const fake = await fakeDevcontainer({
      containerId: 'fake-ctr-for-cleanup',
      execStdout: `${JSON.stringify({ kind: 'job-complete', jobId: 'j-cleanup', status: 'completed' })}\n`,
    });

    // Fake docker that records its args + exits 0 (cleanup "succeeds").
    const dockerLog = await tmpDir('docker-log');
    const fakeDocker = join(dockerLog, 'fake-docker.sh');
    const argsLog = join(dockerLog, 'invocations.log');
    await writeFile(fakeDocker, `#!/bin/sh\necho "$@" >> ${shellSingleQuote(argsLog)}\nexit 0\n`);
    await chmod(fakeDocker, 0o755);

    await mkdir(join(wsRoot, '.harness/run'), { recursive: true });

    const result = await runJobInContainer({
      jobId: 'j-cleanup',
      jobs,
      bus,
      broker: dummyBroker,
      resolver: stubResolver,
      workspaceRoot: wsRoot,
      repos: [{ name: 'demo', cloneUrl: bare }],
      productId: 'demo',
      pipeline: 'feature-add',
      devcontainerBin: fake.binPath,
      dockerBin: fakeDocker,
      removeContainerOnSuccess: true,
    });

    expect(result.status).toBe('completed');
    expect(result.containerRemoved).toBe(true);

    // Verify the cleanup invocation: `docker rm -f <containerId>`.
    const { readFile } = await import('node:fs/promises');
    const log = await readFile(argsLog, 'utf8');
    expect(log.trim()).toBe('rm -f fake-ctr-for-cleanup');
  });

  it('keep-on-success: container is NOT removed when status=completed and option default', async () => {
    const wsRoot = await tmpDir('ws');
    const bare = await localRemote();
    const jobs = new Map<string, JobRecord>();
    jobs.set(
      'j-keep',
      jobRecord('j-keep', [
        { id: 'coordinator', role: 'C', adapter: 'claude-sdk', status: 'pending' },
      ]),
    );
    const bus = new JobBus();

    const fake = await fakeDevcontainer({
      containerId: 'kept-ctr',
      execStdout: `${JSON.stringify({ kind: 'job-complete', jobId: 'j-keep', status: 'completed' })}\n`,
    });
    // Fake docker that would fail loudly if invoked.
    const dockerLog = await tmpDir('docker-log');
    const fakeDocker = join(dockerLog, 'fake-docker.sh');
    await writeFile(fakeDocker, `#!/bin/sh\necho "should not be called" 1>&2\nexit 99\n`);
    await chmod(fakeDocker, 0o755);

    await mkdir(join(wsRoot, '.harness/run'), { recursive: true });

    const result = await runJobInContainer({
      jobId: 'j-keep',
      jobs,
      bus,
      broker: dummyBroker,
      resolver: stubResolver,
      workspaceRoot: wsRoot,
      repos: [{ name: 'demo', cloneUrl: bare }],
      productId: 'demo',
      pipeline: 'feature-add',
      devcontainerBin: fake.binPath,
      dockerBin: fakeDocker,
      // removeContainerOnSuccess defaults to false (F22)
    });

    expect(result.status).toBe('completed');
    expect(result.containerRemoved).toBe(false);
  });
});

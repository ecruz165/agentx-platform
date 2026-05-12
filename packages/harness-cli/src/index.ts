#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  AuthStore,
  fetchGitHubUsername,
  loginGitHubCopilot,
  type Provider,
} from '@ecruz165/agent-auth';
import { type LoaderEvent, spawnLoaderJob } from '@ecruz165/harness-server';
import { udsRequest } from './uds-client.ts';
import {
  findProduct,
  listProductIds,
  readWorkspaceConfig,
  type WorkspaceConfig,
  WorkspaceConfigError,
} from './workspace-config.ts';

/**
 * Path conventions (per prd-workspace-template):
 *   - Auth file is per-user, lives at ~/.agentx/auth.json (decision #5).
 *   - Sockets are workspace-scoped at <workspace>/.harness/run/<service>.sock.
 *     In containerized deployment (MVP-1+), the host's `<workspace>/.harness/run/`
 *     bind-mounts to `~/.harness/run/` inside the container.
 *   - Session is per-user at ~/.agentx/session.json.
 *
 * Workspace discovery: walk up from CWD looking for a `.harness/` directory
 * (the standard "anchor" pattern, like git's `.git/`). Containers (MVP-1+)
 * set HARNESS_WORKSPACE explicitly at spawn so this fallback isn't needed.
 */
const ORG_DIR = join(homedir(), '.agentx');
const AUTH_PATH = join(ORG_DIR, 'auth.json');
const SESSION_PATH = join(ORG_DIR, 'session.json');
const WORKSPACE_ROOT = findWorkspaceRoot();
const SOCKET_DIR = join(WORKSPACE_ROOT, '.harness', 'run');
const HARNESS_SOCKET = join(SOCKET_DIR, 'harness.sock');
const MEMORY_SOCKET = join(SOCKET_DIR, 'memory.sock');
const CONTEXT_SOCKET = join(SOCKET_DIR, 'context.sock');
const WORKSPACE_CONFIG_PATH = WORKSPACE_ROOT;

type Session = Record<string, string>;

function findWorkspaceRoot(): string {
  if (process.env.HARNESS_WORKSPACE) return process.env.HARNESS_WORKSPACE;
  let dir = process.cwd();
  while (true) {
    if (existsSync(join(dir, '.harness'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

async function main() {
  const [namespace, ...rest] = process.argv.slice(2);

  switch (namespace) {
    case 'auth':
      return handleAuth(rest);
    case 'server':
      return handleServer(rest);
    case 'session':
      return handleSession(rest);
    case 'memory':
      return memoryDeprecationNotice();
    case 'context':
      return handleContext(rest);
    case 'steering':
      return handleSteering(rest);
    case 'project':
      return handleProject(rest);
    case 'submit':
      return handleSubmit(rest);
    case 'reap':
      return handleReap(rest);
    case 'tui':
      await import('./tui.tsx');
      return;
    case 'jobs-tui':
      await import('./jobs-tui.tsx');
      return;
    case 'attach':
      return handleAttach(rest);
    default:
      usage();
      process.exit(2);
  }
}

/**
 * `harness attach [jobId]` — read-only tmux peek into the loaders
 * window, optionally focusing the pane for a specific job.
 *
 * Per .plans/2026-04-30-prd-agentic-worker-lib.md §4: the `-r` flag
 * keeps the attach read-only, so a developer can watch progress and
 * scroll history without typing into the worker's stdin.
 *
 * Resolution: each loader pane is titled `load-<jobId>` at spawn time
 * (see harness-server/loader-spawn.ts setupTmuxLoader). We list panes
 * in the loaders window, find the one whose title matches the jobId
 * arg, and `select-pane` to it before attaching.
 *
 * Falls back gracefully:
 *   - tmux not installed → clear error
 *   - no agentx tmux session → clear error
 *   - no matching pane → attach to the loaders window anyway,
 *     log a "couldn't find pane <jobId>" warning
 */
async function handleAttach(args: string[]) {
  const session = process.env.AGENTX_TMUX_SESSION ?? 'agentx';
  const window = 'loaders';
  const jobId = args[0]; // optional positional

  // Best-effort pane resolution if jobId is provided.
  if (jobId) {
    const target = `load-${jobId}`;
    try {
      const panes = await tmuxListPanes(session, window);
      const match = panes.find((p) => p.title === target);
      if (match) {
        await tmuxRun(['select-pane', '-t', match.paneId]);
      } else {
        process.stderr.write(
          `harness attach: no pane titled '${target}' in ${session}:${window}.\n` +
            `  Attaching to the whole loaders window — you can navigate panes with ctrl-b o or ctrl-b q.\n`,
        );
      }
    } catch (err) {
      process.stderr.write(
        `harness attach: pane lookup failed (${(err as Error).message}); attaching to the loaders window.\n`,
      );
    }
  }

  // Inside tmux already → switch-client (don't nest sessions). Outside →
  // attach -r (read-only).
  if (process.env.TMUX) {
    await tmuxExec(['select-window', '-t', `${session}:${window}`]);
  } else {
    await tmuxExec(['attach-session', '-t', session, '-r']);
  }
}

interface PaneInfo {
  paneId: string;
  title: string;
}

async function tmuxListPanes(session: string, window: string): Promise<PaneInfo[]> {
  const out = await tmuxOutput([
    'list-panes',
    '-t',
    `${session}:${window}`,
    '-F',
    '#{pane_id}\t#{pane_title}',
  ]);
  return out
    .split('\n')
    .filter((l) => l.includes('\t'))
    .map((l) => {
      const [paneId, title] = l.split('\t', 2);
      return { paneId: paneId!, title: title ?? '' };
    });
}

/** Run a tmux command and capture stdout; throws on non-zero exit. */
async function tmuxOutput(args: string[]): Promise<string> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (err += c.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`tmux ${args.join(' ')} exited ${code}: ${err.trim()}`));
    });
  });
}

/** Fire-and-forget tmux command; logs stderr on failure but doesn't reject
 *  — used for best-effort operations like select-pane. */
async function tmuxRun(args: string[]): Promise<void> {
  await tmuxOutput(args).catch(() => {});
}

/** Exec the user-facing tmux interaction (attach / switch-client). This
 *  one needs to inherit stdio so the user actually sees / interacts with
 *  tmux. Replaces this process's tty if attaching. */
async function tmuxExec(args: string[]): Promise<void> {
  const { spawn } = await import('node:child_process');
  const child = spawn('tmux', args, { stdio: 'inherit' });
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tmux ${args[0]} exited ${code}`));
    });
  });
}

async function loadWorkspaceConfig(): Promise<WorkspaceConfig> {
  try {
    const cfg = await readWorkspaceConfig(WORKSPACE_CONFIG_PATH);
    if (!cfg) {
      die(
        `No harness-workspace.yml found in ${WORKSPACE_CONFIG_PATH}.\n` +
          `Create one or run from a workspace directory.`,
      );
    }
    return cfg;
  } catch (err) {
    if (err instanceof WorkspaceConfigError) die(err.message);
    throw err;
  }
}

async function handleProject(args: string[]) {
  const [verb, idArg] = args;
  const cfg = await loadWorkspaceConfig();

  if (verb === 'list') {
    console.log(`Workspace: ${cfg.workspace.id}\n`);
    console.log(`Products (${cfg.workspace.products.length}):`);
    for (const p of cfg.workspace.products) {
      const repoNames = p.repos.map((r) => r.name).join(', ');
      console.log(`  - ${p.id}${p.description ? ` — ${p.description}` : ''}`);
      console.log(`      repos: ${repoNames || '(none)'}`);
    }
    return;
  }

  if (verb === 'show') {
    if (!idArg) die('Usage: harness project show <id>');
    const product = findProduct(cfg, idArg);
    if (!product) {
      die(`Product not found: ${idArg}\nKnown: ${listProductIds(cfg).join(', ')}`);
    }
    console.log(`Product: ${product.id}`);
    if (product.description) console.log(`Description: ${product.description}`);
    console.log(`Repos (${product.repos.length}):`);
    for (const r of product.repos) {
      console.log(`  - ${r.name.padEnd(20)} ${r.cloneUrl}  (${r.baseRef})`);
      if (r.path) console.log(`    mount: ${r.path}`);
    }
    if (product.resources) {
      const parts: string[] = [];
      if (product.resources.memory) parts.push(`memory=${product.resources.memory}`);
      if (product.resources.cpu !== undefined) parts.push(`cpu=${product.resources.cpu}`);
      if (parts.length) console.log(`Resources: ${parts.join(', ')}`);
    }
    return;
  }

  die('Usage: harness project <list|show> [id]');
}

async function handleSubmit(args: string[]) {
  const opts = parseSubmitArgs(args);
  const cfg = await loadWorkspaceConfig();
  const session = await readSession();

  const productId = opts.product ?? session.productId;
  if (!productId) {
    die(
      'No productId provided. Pass --product <id>, or run:\n' +
        `  harness session set productId <id>\nKnown: ${listProductIds(cfg).join(', ')}`,
    );
  }
  const product = findProduct(cfg, productId);
  if (!product) {
    die(`Product not registered: ${productId}\nKnown: ${listProductIds(cfg).join(', ')}`);
  }

  const input = await resolveInput(opts);
  if (!input) {
    die(
      'No change/input provided. Usage:\n' +
        '  harness submit --product <id> "<change>"\n' +
        '  or pass --input <file> | --input-text "<text>" | pipe via stdin',
    );
  }

  const jobId = `job_${randomUUID().slice(0, 8)}`;
  const body: Record<string, unknown> = {
    jobId,
    productId: product.id,
    productRepos: product.repos.map((r) => r.name),
    input,
    submittedAt: new Date().toISOString(),
  };
  if (opts.name) body.name = opts.name;
  if (opts.pipeline) body.pipeline = opts.pipeline;

  const label = opts.name ? `${jobId} ("${opts.name}")` : jobId;
  console.log(`Submitting ${label} to harness-server (${HARNESS_SOCKET})…`);
  console.log(`  pipeline:   ${opts.pipeline ?? '(auto-route via coordinator)'}`);
  console.log(`  productId:  ${product.id}`);
  console.log(`  repos:      ${(body.productRepos as string[]).join(', ')}`);
  if (opts.name) console.log(`  name:       ${opts.name}`);
  console.log(`  input:      ${input.length} chars`);

  const resp = await udsRequest(HARNESS_SOCKET, 'POST', '/v1/jobs', body);
  console.log('\nServer response:');
  print(resp.body);
}

interface SubmitOptions {
  change?: string;
  pipeline?: string;
  product?: string;
  name?: string;
  inputFile?: string;
  inputText?: string;
}

function parseSubmitArgs(args: string[]): SubmitOptions {
  const positional: string[] = [];
  const opts: SubmitOptions = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--product') opts.product = args[++i];
    else if (a === '--pipeline') opts.pipeline = args[++i];
    else if (a === '--name') opts.name = args[++i];
    else if (a === '--input') opts.inputFile = args[++i];
    else if (a === '--input-text') opts.inputText = args[++i];
    else if (a?.startsWith('--')) die(`Unknown flag: ${a}`);
    else if (a !== undefined) positional.push(a);
  }
  if (positional.length > 0) opts.change = positional[0];
  return opts;
}

async function resolveInput(opts: SubmitOptions): Promise<string | null> {
  if (opts.change) return opts.change;
  if (opts.inputText) return opts.inputText;
  if (opts.inputFile) {
    const path = resolve(opts.inputFile);
    return await readFile(path, 'utf8');
  }
  if (!process.stdin.isTTY) {
    return await readStdin();
  }
  return null;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// ---------- harness reap (Gate 1d.2) ----------

/** Job statuses that mean the job is done and its resources are eligible
 *  for reaping. Non-terminal statuses (`queued`, `running`,
 *  `awaiting-approval`, `suspended`) are NEVER reaped — that would
 *  destroy live work. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

interface ReapOptions {
  /** When set, restrict reaping to this single jobId. */
  job?: string;
  /** Don't actually reap — just print what would be done. */
  dryRun: boolean;
  /** Pass `git worktree remove --force` (also removes worktrees with
   *  uncommitted changes). Without it, a dirty worktree is left in
   *  place and reported as a failure for that job. */
  force: boolean;
}

interface ReapableJob {
  jobId: string;
  status: string;
  productRepos?: string[];
}

function parseReapArgs(args: string[]): ReapOptions {
  const opts: ReapOptions = { dryRun: false, force: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--job') opts.job = args[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: harness reap [--job <id>] [--dry-run] [--force]\n\n' +
          '  Removes the worker container + per-repo worktrees for terminal\n' +
          '  jobs (completed | failed | cancelled). This is the "explicit\n' +
          '  reaper pass" — workspace.worktree.{keepOnSuccess,keepOnFailure}\n' +
          '  govern AUTOMATIC at-exit cleanup, not this command.\n\n' +
          '  --job <id>   reap only that job\n' +
          '  --dry-run    print what would be reaped, do nothing\n' +
          '  --force      pass `git worktree remove --force` (also removes\n' +
          '               worktrees with uncommitted changes). Without it,\n' +
          '               a dirty worktree is left in place and reported.',
      );
      process.exit(0);
    } else if (a?.startsWith('--')) die(`Unknown flag: ${a}`);
  }
  return opts;
}

async function handleReap(args: string[]) {
  const opts = parseReapArgs(args);

  // Pull job list from harness-server. The server is in-memory today, so
  // jobs that ran before a restart aren't visible here — those leave
  // orphan worktrees. A future `--orphans` flag can scan the filesystem
  // directly; for now we trust the server's view.
  const resp = await udsRequest(HARNESS_SOCKET, 'GET', '/v1/jobs', null);
  if (!resp.body || typeof resp.body !== 'object') {
    die(`Unexpected response from harness-server: ${JSON.stringify(resp.body)}`);
  }
  const allJobs = (resp.body as { jobs?: ReapableJob[] }).jobs ?? [];

  // `harness reap` is the *explicit* cleanup action, so it targets every
  // terminal job (the `worktree.keepOn*` settings govern AUTOMATIC
  // at-exit cleanup — see ServerCtx.worktreePolicy — not this command;
  // otherwise `keepOnSuccess: true`, the default, would mean disk is
  // never reclaimed). `cancelled` counts as terminal like the rest.
  // Never touch running/paused jobs — that would destroy live work.
  const candidates = allJobs.filter((j) => {
    if (!TERMINAL_STATUSES.has(j.status)) return false;
    if (opts.job && j.jobId !== opts.job) return false;
    return true;
  });

  if (candidates.length === 0) {
    console.log('Nothing to reap.');
    return;
  }

  console.log(`${opts.dryRun ? '[dry-run] ' : ''}Reaping ${candidates.length} job(s):`);
  for (const job of candidates) {
    console.log(`  - ${job.jobId} (${job.status})`);
  }
  if (opts.dryRun) return;

  let reaped = 0;
  let failed = 0;
  for (const job of candidates) {
    try {
      await reapOneJob(job, opts.force);
      reaped++;
    } catch (err) {
      failed++;
      console.error(`  ! ${job.jobId}: ${(err as Error).message}`);
    }
  }
  console.log(`Done — ${reaped} reaped, ${failed} failed.`);
}

async function reapOneJob(job: ReapableJob, force: boolean): Promise<void> {
  // (1) Remove the worker container (if any). We discover the container
  // via the labels the worker Dockerfile sets at spawn time.
  const containerId = await findContainerByJobLabel(job.jobId);
  if (containerId) {
    await runCmd('docker', ['rm', '-f', containerId]);
  }

  // (2) Remove per-repo worktrees under .harness/wt/<jobId>/<subagent>/<repo>/.
  // `git worktree remove` must be run from inside the bare clone, which
  // lives at .harness/repos/<repoName>.git.
  await removeWorktreesForJob(WORKSPACE_ROOT, job.jobId, force);

  // (3) Best-effort: remove the now-empty .harness/wt/<jobId>/ dir.
  const jobDir = join(WORKSPACE_ROOT, '.harness', 'wt', job.jobId);
  await rm(jobDir, { recursive: true, force: true }).catch(() => {});
}

async function findContainerByJobLabel(jobId: string): Promise<string | null> {
  // `docker ps -a` includes exited containers. The worker Dockerfile
  // (workspace-template/.devcontainer/worker/Dockerfile) labels every
  // worker with harness-job-id=<id>. One container per job.
  const { stdout } = await runCmd('docker', [
    'ps',
    '-a',
    '--filter',
    `label=harness-job-id=${jobId}`,
    '--format',
    '{{.ID}}',
  ]);
  const id = stdout.trim().split('\n')[0];
  return id || null;
}

async function removeWorktreesForJob(
  workspaceRoot: string,
  jobId: string,
  force: boolean,
): Promise<void> {
  const wtRoot = join(workspaceRoot, '.harness', 'wt', jobId);
  const reposRoot = join(workspaceRoot, '.harness', 'repos');
  if (!existsSync(wtRoot)) return;

  // Layout: .harness/wt/<jobId>/<subagentId>/<repoName>/
  const subagents = await readdir(wtRoot, { withFileTypes: true });
  for (const subagentEnt of subagents) {
    if (!subagentEnt.isDirectory()) continue;
    const subagentDir = join(wtRoot, subagentEnt.name);
    const repos = await readdir(subagentDir, { withFileTypes: true });
    for (const repoEnt of repos) {
      if (!repoEnt.isDirectory()) continue;
      const worktreePath = join(subagentDir, repoEnt.name);
      const bareRepo = join(reposRoot, `${repoEnt.name}.git`);
      if (!existsSync(bareRepo)) {
        // Orphan worktree (bare clone gone). rm -rf and move on — there's
        // no git metadata left to update.
        await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      // Without --force, `git worktree remove` refuses on a dirty
      // worktree — the operator gets told and the tree is left for
      // inspection. With --force, it's removed regardless.
      const gitArgs = ['-C', bareRepo, 'worktree', 'remove', worktreePath];
      if (force) gitArgs.splice(4, 0, '--force');
      await runCmd('git', gitArgs);
    }
  }
}

async function runCmd(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('close', (code) => {
      if (code !== 0) {
        rejectP(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolveP({ stdout, stderr, code: code ?? 0 });
    });
    child.on('error', rejectP);
  });
}

async function handleAuth(args: string[]) {
  const [verb, providerArg] = args;
  const store = new AuthStore(AUTH_PATH);

  if (verb === 'login') {
    const provider = (providerArg ?? 'github-copilot') as Provider;
    if (provider !== 'github-copilot') {
      die(`Login flow not implemented for ${provider}. Edit ${AUTH_PATH} directly.`);
    }
    process.stderr.write(`\n→ Starting GitHub Device Flow for Copilot…\n`);
    const result = await loginGitHubCopilot();
    const username = await fetchGitHubUsername(result.apiKey);
    await store.setProvider('github-copilot', {
      apiKey: result.apiKey,
      tokenType: result.tokenType,
      scope: result.scope,
      expiresAt: result.expiresAt,
      username: username ?? undefined,
    });
    console.log(
      `✓ github-copilot authenticated${username ? ` as @${username}` : ''}. Token saved to ${AUTH_PATH}`,
    );
    console.log(`  Length: ${result.apiKey.length}, scope: ${result.scope || '(default)'}`);
    return;
  }

  if (verb === 'status') {
    const status = await store.status();
    if (Object.keys(status).length === 0) {
      console.log('No providers configured.');
      return;
    }
    for (const [provider, info] of Object.entries(status)) {
      const tag = info.authenticated ? '✓' : '✗';
      const parts: string[] = [];
      if (info.authenticated) {
        parts.push(`length=${info.tokenLength}`);
        if (info.username) parts.push(`@${info.username}`);
        if (info.scope) parts.push(`scope=${info.scope}`);
        if (info.hasCopilotSessionToken && info.copilotSessionExpiresIn !== undefined) {
          const min = Math.max(0, Math.round(info.copilotSessionExpiresIn / 60));
          parts.push(`copilot-session: ${min}m left`);
        }
      } else {
        parts.push('placeholder — not authenticated');
      }
      console.log(`  ${tag} ${provider}: ${parts.join(', ')}`);
    }
    return;
  }

  if (verb === 'logout') {
    if (!providerArg) die('Usage: harness auth logout <provider>');
    const removed = await store.removeProvider(providerArg as Provider);
    console.log(removed ? `Removed ${providerArg}.` : `${providerArg} was not configured.`);
    return;
  }

  die('Usage: harness auth <login|status|logout> [provider]');
}

async function handleServer(args: string[]) {
  const [verb] = args;

  if (verb === 'status') {
    const sockets: Array<[string, string]> = [
      ['harness', HARNESS_SOCKET],
      ['memory', MEMORY_SOCKET],
      ['context', CONTEXT_SOCKET],
    ];
    for (const [name, path] of sockets) {
      const live = existsSync(path);
      console.log(
        `  ${live ? '✓' : '✗'} ${name.padEnd(8)} ${live ? 'running' : 'down  '}  ${path}`,
      );
    }
    return;
  }

  if (verb === 'start' || verb === 'stop' || verb === 'restart') {
    console.error(`MVP-0: server lifecycle is via 'pnpm dev:servers' in a separate terminal.`);
    console.error(`MVP-1+: '${verb}' will wrap docker-compose per workspace-setup-cli F13–F16.`);
    process.exit(2);
  }

  die('Usage: harness server <status|start|stop>');
}

async function handleSession(args: string[]) {
  const [verb, key, ...rest] = args;
  const session = await readSession();

  if (verb === 'show') {
    console.log(JSON.stringify(session, null, 2));
    return;
  }
  if (verb === 'get') {
    if (!key) die('Usage: harness session get <key>');
    console.log(session[key] ?? '');
    return;
  }
  if (verb === 'set') {
    if (!key || rest.length === 0) die('Usage: harness session set <key> <value>');
    session[key] = rest.join(' ');
    await writeSession(session);
    console.log(`session.${key} = ${session[key]}`);
    return;
  }
  die('Usage: harness session <show|get|set>');
}

/**
 * The `harness memory ...` subcommand was removed when memory moved to
 * its own peer CLI (`@ecruz165/edge-memory-cli`). harness-cli is now
 * operator/orchestrator only — agent surfaces (memory, context,
 * steering check) live in their own packages so cold-start stays
 * tight on every agent invocation. See memory note
 * `project_per_server_cli_packages.md`.
 *
 * This shim exists only so a stale `harness memory ...` invocation
 * gets a useful error rather than the generic "unknown command"
 * usage dump. Remove entirely once the deprecation cycle is over
 * (and any agent / docs / SKILL files have been updated to call
 * `edge-memory` directly).
 */
function memoryDeprecationNotice(): never {
  console.error(
    [
      '`harness memory` was moved to its own peer CLI: `edge-memory`.',
      '',
      'Equivalent commands:',
      '  harness memory query <key>          →  edge-memory query --type structured --key <key>',
      '  harness memory put <key> <value>    →  edge-memory put <key> --value "<value>"',
      '',
      'Install:',
      '  npm install -g @ecruz165/edge-memory-cli   # or pnpm/yarn equivalent',
      '',
      'See `edge-memory --help` for the full subcommand surface',
      '(query / put / forget / health) plus --scope, --json, etc.',
    ].join('\n'),
  );
  process.exit(2);
}

/**
 * `harness steering` — operator-facing CLI to push or read steering
 * context attached to an in-flight or paused job.
 *
 * Surface:
 *   harness steering check [--job <id>]
 *     GET /v1/jobs/<id>/steering — print the current steering array.
 *     Reads $HARNESS_JOB_ID from env when --job is omitted.
 *
 *   harness steering push --text "<text>" [--job <id>]
 *     POST /v1/jobs/<id>/steering — append a steering entry. Lands on
 *     the agent's systemPrompt at next adapter invocation (passive)
 *     AND on `harness steering check` immediately (active).
 *
 *   harness steering wait [--job <id>] [--since <ts>]
 *     Long-poll: returns when steering changes. v1 implements as a
 *     simple polling loop on the GET endpoint with a 30s default
 *     timeout. Server-side push (SSE) is a follow-up.
 *
 * Per the steering.md SKILL pattern: agents Bash-call `harness steering
 * check` between LLM turns to pick up operator-injected guidance
 * mid-job. Operators (or peer agents) push via `harness steering push`.
 *
 * jobId resolution: agents running in container workers inherit
 * HARNESS_JOB_ID from spawn-worker. In-process adapter calls do NOT
 * propagate per-job env (the harness-server process is shared across
 * concurrent jobs); for those callers, --job <id> is required.
 */
async function handleSteering(args: string[]) {
  const [verb, ...rest] = args;
  const parsed = parseRawArgs(rest);
  const jobId = parsed.flags.job ?? process.env.HARNESS_JOB_ID;

  if (verb === 'check') {
    if (!jobId) {
      die(
        'No jobId provided. Pass --job <id>, or set $HARNESS_JOB_ID in env\n' +
          '(container workers inherit HARNESS_JOB_ID from spawn-worker; in-process callers must pass --job).',
      );
    }
    const resp = await udsRequest(HARNESS_SOCKET, 'GET', `/v1/jobs/${jobId}/steering`);
    print(resp.body);
    return;
  }

  if (verb === 'push') {
    if (!jobId) {
      die('No jobId provided. Pass --job <id> or set $HARNESS_JOB_ID.');
    }
    const text = parsed.flags.text;
    if (!text || text === 'true') {
      die('Usage: harness steering push --text "<text>" [--job <id>]');
    }
    const resp = await udsRequest(HARNESS_SOCKET, 'POST', `/v1/jobs/${jobId}/steering`, { text });
    print(resp.body);
    return;
  }

  if (verb === 'wait') {
    if (!jobId) {
      die('No jobId provided. Pass --job <id> or set $HARNESS_JOB_ID.');
    }
    const sinceStr = parsed.flags.since;
    const sinceCount = sinceStr ? Number(sinceStr) : 0;
    if (sinceStr && Number.isNaN(sinceCount)) {
      die(
        '--since must be an integer count of already-seen steering entries (got: ' + sinceStr + ')',
      );
    }
    const timeoutMs = Number(parsed.flags.timeout ?? '30000');
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const resp = await udsRequest(HARNESS_SOCKET, 'GET', `/v1/jobs/${jobId}/steering`);
      const body = (resp.body as Record<string, unknown>) ?? {};
      const arr = Array.isArray(body.steering) ? (body.steering as string[]) : [];
      if (arr.length > sinceCount) {
        print({ ...body, since: sinceCount, newEntries: arr.slice(sinceCount) });
        return;
      }
      // Poll interval: tight enough to feel responsive, loose enough to
      // not hammer the UDS socket. 500ms is a reasonable default.
      await new Promise((r) => setTimeout(r, 500));
    }
    die(
      `harness steering wait: timed out after ${timeoutMs}ms (no new entries since ${sinceCount})`,
    );
  }

  die('Usage: harness steering <check|push|wait> [--job <id>] [--text "..."] [--since <count>]');
}

async function handleContext(args: string[]) {
  const session = await readSession();
  const [verb, ...rest] = args;

  if (verb === 'query') {
    const q = rest.join(' ');
    if (!q) die('Usage: harness context query <text>');
    const resp = await udsRequest(CONTEXT_SOCKET, 'POST', '/v1/context/query', {
      q,
      productId: requireProductId(session),
    });
    print(resp.body);
    return;
  }

  if (verb === 'load') {
    return handleContextLoad(rest);
  }

  die('Usage: harness context <query|load>');
}

interface LoadFlags {
  target: string;
  type: string;
  backend: string;
  backendUser?: string;
  backendPassword?: string;
  embedderUrl: string;
  embedderModel?: string;
  embedderDim?: number;
}

interface ParsedRawArgs {
  positional: string | undefined;
  flags: Record<string, string>;
}

function parseRawArgs(args: string[]): ParsedRawArgs {
  let positional: string | undefined;
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const [k, vInline] = a.slice(2).split('=', 2);
      if (vInline !== undefined) {
        flags[k!] = vInline;
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[k!] = next;
          i++;
        } else {
          flags[k!] = 'true';
        }
      }
    } else if (positional === undefined) {
      positional = a;
    } else {
      die(`unexpected positional '${a}' (already have '${positional}')`);
    }
  }
  return { positional, flags };
}

function flagsToLoadFlags(parsed: ParsedRawArgs, target: string): LoadFlags {
  const { flags } = parsed;
  if (!flags.type) die('missing required --type <id>');
  if (!flags.backend) die('missing required --backend <url>');
  if (!flags['embedder-url']) die('missing required --embedder-url <url>');
  return {
    target,
    type: flags.type,
    backend: flags.backend,
    backendUser: flags['backend-user'],
    backendPassword: flags['backend-password'] ?? process.env.NEO4J_PASSWORD,
    embedderUrl: flags['embedder-url'],
    embedderModel: flags['embedder-model'],
    embedderDim: flags['embedder-dim'] ? Number(flags['embedder-dim']) : undefined,
  };
}

async function handleContextLoad(args: string[]) {
  const parsed = parseRawArgs(args);

  // Two dispatch shapes:
  //   1. `harness context load <target> --type X --backend Y ...`
  //      — single explicit source.
  //   2. `harness context load --product <id>`
  //      — fan out across the product's declared contextSources from
  //        harness-workspace.yml. Per-source overrides win; CLI flags
  //        provide workspace-default fallbacks for anything not declared.
  const productId = parsed.flags.product;
  if (productId) {
    return loadAllProductSources(productId, parsed);
  }
  if (!parsed.positional) {
    die('Usage: harness context load <target> [flags]\n   or: harness context load --product <id>');
  }
  return loadSingleSource(flagsToLoadFlags(parsed, resolve(parsed.positional!)), undefined);
}

async function loadAllProductSources(productId: string, parsed: ParsedRawArgs): Promise<void> {
  // When harness-server is up, delegate the entire fan-out: server reads
  // its catalog (sourced from harness-workspace.yml at startup), spawns
  // one worker per contextSource, and registers each as a separate job
  // so jobs-tui sees all of them concurrently.
  if (existsSync(HARNESS_SOCKET)) {
    const resp = await udsRequest(HARNESS_SOCKET, 'POST', '/v1/loader-jobs', {
      productId,
      // Workspace defaults — per-source declarations in the catalog win.
      backend: parsed.flags.backend,
      backendUser: parsed.flags['backend-user'],
      backendPassword: parsed.flags['backend-password'] ?? process.env.NEO4J_PASSWORD,
      embedderUrl: parsed.flags['embedder-url'],
      embedderModel: parsed.flags['embedder-model'],
      embedderDim: parsed.flags['embedder-dim'] ? Number(parsed.flags['embedder-dim']) : undefined,
      workspaceRoot: WORKSPACE_ROOT,
    });
    const body = resp.body as {
      ok: boolean;
      spawnedJobIds?: string[];
      count?: number;
      error?: string;
    } | null;
    if (!body?.ok) {
      die(`harness-server: ${body?.error ?? 'unknown error'}`);
    }
    process.stderr.write(
      `harness context load: spawned ${body.count ?? 0} loader job(s) for product '${productId}':\n`,
    );
    for (const id of body.spawnedJobIds ?? []) {
      process.stderr.write(`  ${id}\n`);
    }
    process.stderr.write(`Watch live: harness jobs-tui  (or in tmux: ctrl-b L)\n`);
    process.exit(0);
  }

  // Fallback: harness-server not running. Read the workspace YAML
  // directly and run loaders in-process, one at a time. Same UX as
  // before harness-server was wired in.
  const config = await loadWorkspaceConfig();
  const product = findProduct(config, productId);
  if (!product) {
    const known = listProductIds(config);
    die(`unknown product '${productId}'. Known: ${known.join(', ') || '(none)'}`);
  }
  if (!product.contextSources || product.contextSources.length === 0) {
    die(
      `product '${productId}' has no contextSources declared in harness-workspace.yml.\n` +
        `Add a contextSources: [{ type, target, ... }] block under the product.`,
    );
  }
  const defaultBackend = parsed.flags.backend;
  const defaultEmbedderUrl = parsed.flags['embedder-url'];
  process.stderr.write(
    `harness context load: product '${productId}' has ${product.contextSources.length} source(s) (in-process; harness-server not running)\n`,
  );
  let totalErrors = 0;
  for (const src of product.contextSources) {
    const backend = src.backend ?? defaultBackend;
    const embedderUrl = src.embedderUrl ?? defaultEmbedderUrl;
    if (!backend)
      die(
        `source ${src.type}/${src.target}: no backend (set --backend or contextSources[].backend)`,
      );
    if (!embedderUrl) {
      die(
        `source ${src.type}/${src.target}: no embedder-url (set --embedder-url or contextSources[].embedderUrl)`,
      );
    }
    const target =
      src.target.startsWith('/') || src.target.includes('://')
        ? src.target
        : resolve(WORKSPACE_ROOT, src.target);
    process.stderr.write(`\n[${src.type}] ${target}\n`);
    const errs = await loadSingleSource(
      {
        target,
        type: src.type,
        backend,
        backendUser: parsed.flags['backend-user'],
        backendPassword: parsed.flags['backend-password'] ?? process.env.NEO4J_PASSWORD,
        embedderUrl,
        embedderModel: src.embedderModel ?? parsed.flags['embedder-model'],
        embedderDim:
          src.embedderDim ??
          (parsed.flags['embedder-dim'] ? Number(parsed.flags['embedder-dim']) : undefined),
      },
      productId,
      { exitOnComplete: false },
    );
    totalErrors += errs;
  }
  process.exit(totalErrors > 0 ? 1 : 0);
}

interface LoadOpts {
  /** When false, the function returns the error count instead of calling
   *  process.exit (so the multi-source loop can aggregate). */
  exitOnComplete?: boolean;
}

async function loadViaHarnessServer(
  jobId: string,
  flags: LoadFlags,
  productId: string | undefined,
  exitOnComplete: boolean,
): Promise<number> {
  // Submit the intent — server responds OK once it has registered the job
  // and started the loader. Progress flows back via SSE on the existing
  // /v1/jobs/:id/events stream, picked up by jobs-tui automatically.
  await udsRequest(HARNESS_SOCKET, 'POST', '/v1/loader-jobs', {
    jobId,
    name: productId ? `load: ${flags.type} (${productId})` : `load: ${flags.type}`,
    productId,
    target: flags.target,
    type: flags.type,
    backend: flags.backend,
    backendUser: flags.backendUser,
    backendPassword: flags.backendPassword,
    embedderUrl: flags.embedderUrl,
    embedderModel: flags.embedderModel,
    embedderDim: flags.embedderDim,
    workspaceRoot: WORKSPACE_ROOT,
  });

  process.stderr.write(
    `harness context load: submitted ${jobId} to harness-server.\n` +
      `  Open jobs-tui (\`harness jobs-tui\`) to watch progress live.\n` +
      `  Or follow events: harness jobs ${jobId} events (TBD).\n`,
  );

  // We deliberately do NOT block on completion — the server owns the
  // job's lifecycle now, and the human's typing thread is freed up to
  // open jobs-tui or move on. Exit code 0 means "submitted," not
  // "completed." For the wait-here behavior, users can fall back to the
  // in-process path by stopping harness-server first.
  if (exitOnComplete) process.exit(0);
  return 0;
}

async function loadSingleSource(
  flags: LoadFlags,
  productId: string | undefined,
  opts: LoadOpts = { exitOnComplete: true },
): Promise<number> {
  const exitOnComplete = opts.exitOnComplete ?? true;
  // jobId stays short to keep the per-job UDS path under the 104-byte
  // OS limit on macOS — workspaceRoot can already be deep, so we don't
  // burn budget encoding the productId here. The product association is
  // already captured on every emitted node's sourceId.
  const jobId = `l-${randomUUID().slice(0, 8)}`;

  // Dual-mode dispatch (per project_dual_mode_local_and_ecs):
  //   - If HARNESS_SOCKET is reachable, POST a LoaderJobIntent so the
  //     loader runs under harness-server and is visible to jobs-tui.
  //   - Otherwise, spawn the loader in-process. Same observed behavior
  //     for the user; only difference is whether jobs-tui can see it.
  if (existsSync(HARNESS_SOCKET)) {
    return loadViaHarnessServer(jobId, flags, productId, exitOnComplete);
  }

  // Auto-tmux: when running inside an `agentx` tmux session, spawn the
  // loader in its own pane in the `loaders` window. Each concurrent
  // load gets a dedicated pane with native scrollback + the live
  // --output progress bar redrawing in place. UDS events still flow to
  // the parent so any TUI subscribers see structured updates too.
  // Outside tmux, fall back to direct spawn (current behavior).
  const tmuxPane =
    process.env.TMUX && (process.env.AGENTX_TMUX_SESSION ?? 'agentx')
      ? {
          session: process.env.AGENTX_TMUX_SESSION ?? 'agentx',
          window: 'loaders',
        }
      : undefined;
  const handle = await spawnLoaderJob({
    jobId,
    target: flags.target,
    type: flags.type,
    backend: flags.backend,
    backendUser: flags.backendUser,
    backendPassword: flags.backendPassword,
    embedderUrl: flags.embedderUrl,
    embedderModel: flags.embedderModel,
    embedderDim: flags.embedderDim,
    workspaceRoot: WORKSPACE_ROOT,
    tmuxPane,
  });

  // Render progress to stderr so stdout stays clean for the final summary.
  // Same shape as agentx-load's --output progress mode but driven from
  // events arriving over the UDS instead of in-process emission.
  const counts = {
    files: 0,
    chunks: 0,
    nodes: 0,
    edges: 0,
    vectors: 0,
    errors: 0,
    lastItem: '',
  };
  const renderProgress = (): void => {
    const line =
      `files=${counts.files} chunks=${counts.chunks} nodes=${counts.nodes} ` +
      `edges=${counts.edges} vectors=${counts.vectors} errors=${counts.errors}` +
      (counts.lastItem ? `  ${counts.lastItem}` : '');
    process.stderr.write(`\r\x1b[K${line}`);
  };

  handle.subscribe((e: LoaderEvent) => {
    switch (e.kind) {
      case 'item-walked':
        counts.files++;
        counts.lastItem = String(e.itemId ?? '').slice(-40);
        break;
      case 'chunk-produced':
        counts.chunks += Number(e.chunkCount ?? 0);
        break;
      case 'node-written':
        counts.nodes++;
        break;
      case 'edge-written':
        counts.edges++;
        break;
      case 'chunk-embedded':
        counts.vectors++;
        break;
      case 'error':
        counts.errors++;
        process.stderr.write(`\nerror at ${e.phase}: ${e.message}\n`);
        break;
    }
    renderProgress();
  });

  try {
    const completion = await handle.whenComplete;
    process.stderr.write(`\r\x1b[K`);
    print({
      jobId: completion.jobId,
      filesIngested: completion.filesIngested,
      chunksWritten: completion.chunksWritten,
      vectorsWritten: completion.vectorsWritten,
      errors: completion.errors,
    });
    const errs = Number(completion.errors ?? 0);
    if (exitOnComplete) process.exit(errs > 0 ? 1 : 0);
    return errs;
  } catch (err) {
    process.stderr.write(`\r\x1b[K`);
    if (exitOnComplete) die(`load job failed: ${(err as Error).message}`);
    process.stderr.write(`load job failed: ${(err as Error).message}\n`);
    return 1;
  }
}

async function readSession(): Promise<Session> {
  try {
    return JSON.parse(await readFile(SESSION_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function writeSession(session: Session): Promise<void> {
  await mkdir(ORG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(SESSION_PATH, JSON.stringify(session, null, 2), { mode: 0o600 });
  await chmod(SESSION_PATH, 0o600);
}

function requireProductId(session: Session): string {
  const id = session.productId;
  if (!id) {
    die(
      'productId not set. Run: harness session set productId <id>\n' +
        '(Decision #4: every memory/context call must be product-scoped.)',
    );
  }
  return id;
}

function print(body: unknown): void {
  console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

function die(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function usage(): void {
  console.error(
    [
      'Usage:',
      '  harness auth <login|status|logout> [provider]   # default provider: github-copilot',
      '  harness server <status|start|stop>',
      '  harness tui                                   # interactive ops dashboard',
      '  harness jobs-tui                              # 3-column jobs/agents/events viewer',
      '  harness session <show|get|set> [key] [value]',
      '  harness project <list|show> [id]',
      '  harness submit "<change>" [--product <id>] [--pipeline <id>] [--name "<title>"] [--input <file>|--input-text "<text>"]',
      '  harness reap [--job <id>] [--dry-run] [--force]   # remove containers + worktrees for terminal (done) jobs',
      '  harness steering <check|push|wait> [--job <id>] [--text "..."]',
      '',
      '  # Memory operations moved to a peer CLI:',
      '  edge-memory <query|put|forget|health> ...   # @ecruz165/edge-memory-cli',
      '  harness context query <text>',
      '  harness context load <target> --type <id> --backend <url> --embedder-url <url>',
      "  harness context load --product <id>            # loads all of a product's declared contextSources",
      '  harness attach [jobId]                         # read-only tmux peek; attaches to loaders window',
    ].join('\n'),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

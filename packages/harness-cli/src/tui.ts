import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import YAML from 'yaml';
import { AuthStore } from '@agentx/auth-lib';
import { udsRequest } from './uds-client.ts';
import {
  readPipelines,
  type PipelineCatalog,
  type PipelineConfig,
} from './workspace-config.ts';

/**
 * Basic TUI for the agentx ops dashboard.
 *
 * Plain Node + ANSI + readline — no Ink/blessed dependency. Status fields
 * are just file stats (auth.json mode, UDS socket presence) so what the TUI
 * displays is *current* system state, not cached state.
 *
 * Modes (line-based state machine):
 *   menu                  — main commands (l/s/p/r/q)
 *   awaitingIntent        — typing free-text intent for `harness submit`
 *   awaitingProductPick   — typing a number from the product list
 *   awaitingLoginReturn   — login subprocess just exited; press Enter to refresh
 */

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const CLEAR = '\x1b[2J\x1b[H';

const ORG_DIR = join(homedir(), '.agentx');
const AUTH_PATH = join(ORG_DIR, 'auth.json');
const SESSION_PATH = join(ORG_DIR, 'session.json');

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

const WORKSPACE_ROOT = findWorkspaceRoot();
const RUN_DIR = join(WORKSPACE_ROOT, '.harness', 'run');
const HARNESS_SOCKET = join(RUN_DIR, 'harness.sock');
const YAML_PATH = join(WORKSPACE_ROOT, 'harness-workspace.yml');

interface JobSummary {
  jobId: string;
  name?: string;
  pipeline?: string;
  productId?: string;
  productRepos?: string[];
  status?: string;
  submittedAt?: string;
  input?: string;
}

interface State {
  authenticated: boolean;
  username?: string;
  copilotSessionExpiresIn?: number;
  productId: string;
  productList: string[];
  recentJobs: string[];
  busy: string | null;
  trio: { harness: boolean; memory: boolean; context: boolean };
  jobs: JobSummary[];
  selectedJob: JobSummary | null;
  pipelines: PipelineConfig[];
  selectedPipeline: PipelineConfig | null;
  pendingPipelineId: string | null; // chosen during awaitingPipelinePick → used at submit
}

type Mode =
  | 'menu'
  | 'awaitingPipelinePick'
  | 'awaitingIntent'
  | 'awaitingProductPick'
  | 'awaitingLoginReturn'
  | 'jobs'
  | 'jobDetail'
  | 'pipelines'
  | 'pipelineDetail';

const state: State = {
  authenticated: false,
  productId: '(unset)',
  productList: [],
  recentJobs: [],
  busy: null,
  trio: { harness: false, memory: false, context: false },
  jobs: [],
  selectedJob: null,
  pipelines: [],
  selectedPipeline: null,
  pendingPipelineId: null,
};
let mode: Mode = 'menu';

async function refreshAll(): Promise<void> {
  try {
    const store = new AuthStore(AUTH_PATH);
    const s = await store.status();
    const cp = s['github-copilot'];
    state.authenticated = !!cp?.authenticated;
    state.username = cp?.username;
    state.copilotSessionExpiresIn = cp?.copilotSessionExpiresIn;
  } catch {
    state.authenticated = false;
  }

  try {
    const session = JSON.parse(await readFile(SESSION_PATH, 'utf8'));
    state.productId = session.productId ?? '(unset)';
  } catch {
    state.productId = '(unset)';
  }

  try {
    const cfg = YAML.parse(await readFile(YAML_PATH, 'utf8')) as {
      workspace: { products: Array<{ id: string }> };
    };
    state.productList = cfg.workspace.products.map((p) => p.id);
  } catch {
    state.productList = [];
  }

  state.trio.harness = existsSync(HARNESS_SOCKET);
  state.trio.memory = existsSync(join(RUN_DIR, 'memory.sock'));
  state.trio.context = existsSync(join(RUN_DIR, 'context.sock'));

  try {
    const catalog: PipelineCatalog | null = await readPipelines(WORKSPACE_ROOT);
    state.pipelines = catalog?.pipelines ?? [];
  } catch {
    state.pipelines = [];
  }

  await refreshJobs();
}

async function refreshJobs(): Promise<void> {
  if (!state.trio.harness) {
    state.jobs = [];
    return;
  }
  try {
    const resp = await udsRequest(HARNESS_SOCKET, 'GET', '/v1/jobs');
    const body = resp.body as { ok?: boolean; jobs?: JobSummary[] } | null;
    state.jobs = body?.jobs ?? [];
  } catch {
    state.jobs = [];
  }
}

async function loadJobDetail(id: string): Promise<JobSummary | null> {
  if (!state.trio.harness) return null;
  try {
    const resp = await udsRequest(HARNESS_SOCKET, 'GET', `/v1/jobs/${id}`);
    const body = resp.body as { ok?: boolean; job?: JobSummary } | null;
    return body?.job ?? null;
  } catch {
    return null;
  }
}

function render(): void {
  process.stdout.write(CLEAR);
  const bar = '─'.repeat(34);
  console.log(`${CYAN}╭${bar}╮${RESET}`);
  console.log(`${CYAN}│${RESET}  ${BOLD}agentx ops dashboard${RESET}            ${CYAN}│${RESET}`);
  console.log(`${CYAN}╰${bar}╯${RESET}`);
  console.log();

  console.log(`${BOLD}Authentication${RESET}`);
  if (state.authenticated) {
    const who = state.username ? ` ${BOLD}@${state.username}${RESET}` : '';
    console.log(`  ${GREEN}✓${RESET} github-copilot${who}`);
    if (state.copilotSessionExpiresIn !== undefined && state.copilotSessionExpiresIn > 0) {
      console.log(`  ${DIM}copilot session: ${Math.round(state.copilotSessionExpiresIn / 60)}m left${RESET}`);
    }
  } else {
    console.log(`  ${RED}✗${RESET} not authenticated`);
    console.log(`  ${DIM}press [L] then Enter to log in via GitHub${RESET}`);
  }

  console.log();
  console.log(`${BOLD}Peer servers (sockets)${RESET}`);
  const dot = (ok: boolean) => (ok ? `${GREEN}●${RESET}` : `${RED}○${RESET}`);
  console.log(`  ${dot(state.trio.harness)} harness-server`);
  console.log(`  ${dot(state.trio.memory)} edge-memory-server`);
  console.log(`  ${dot(state.trio.context)} edge-context-server`);

  console.log();
  console.log(`${BOLD}Active product${RESET}`);
  const colored = state.productId === '(unset)' ? `${RED}${state.productId}${RESET}` : state.productId;
  console.log(`  ${colored}`);

  if (state.pipelines.length) {
    console.log();
    console.log(`${BOLD}Pipelines${RESET} (${state.pipelines.length} registered)`);
    for (const p of state.pipelines.slice(0, 6)) {
      const phaseList = (p.phases ?? []).map((ph) => ph.id).join('→');
      console.log(`  ${DIM}-${RESET} ${p.id.padEnd(28)} ${DIM}${(p.phases?.length ?? 0)} phases${RESET}  ${DIM}${phaseList}${RESET}`);
    }
  }

  if (state.recentJobs.length) {
    console.log();
    console.log(`${BOLD}Recent submissions${RESET}`);
    for (const j of state.recentJobs) console.log(`  ${DIM}· ${j}${RESET}`);
  }

  if (state.busy) {
    console.log();
    console.log(`${YELLOW}⏳ ${state.busy}${RESET}`);
  }

  console.log();
  console.log(`${DIM}${'─'.repeat(36)}${RESET}`);
  if (mode === 'menu') {
    console.log(`${DIM}commands (letter + Enter):${RESET}`);
    if (!state.authenticated) {
      console.log(`  ${BOLD}l${RESET} login via GitHub`);
    } else {
      console.log(`  ${BOLD}s${RESET} submit an intent`);
      console.log(`  ${BOLD}p${RESET} pick a product`);
    }
    console.log(`  ${BOLD}j${RESET} active jobs (${state.jobs.length})`);
    console.log(`  ${BOLD}L${RESET} pipelines (${state.pipelines.length})`);
    console.log(`  ${BOLD}r${RESET} refresh   ${BOLD}q${RESET} quit`);
    process.stdout.write('\n> ');
  } else if (mode === 'awaitingPipelinePick') {
    console.log(`${DIM}pick a pipeline (Enter on empty cancels):${RESET}`);
    state.pipelines.forEach((p, i) => {
      const phaseList = (p.phases ?? []).map((ph) => ph.id).join('→');
      console.log(`  ${BOLD}${i + 1}.${RESET} ${p.id.padEnd(28)} ${DIM}${phaseList}${RESET}`);
    });
    process.stdout.write('\n> ');
  } else if (mode === 'awaitingIntent') {
    const pipelineLine = state.pendingPipelineId ? ` (pipeline: ${state.pendingPipelineId})` : '';
    console.log(`${DIM}type your intent and press Enter${pipelineLine} — empty cancels:${RESET}`);
    process.stdout.write('\n> ');
  } else if (mode === 'awaitingProductPick') {
    console.log(`${DIM}pick a product:${RESET}`);
    state.productList.forEach((id, i) => console.log(`  ${i + 1}. ${id}`));
    process.stdout.write('\n> ');
  } else if (mode === 'awaitingLoginReturn') {
    console.log(`${DIM}press Enter to refresh${RESET}`);
    process.stdout.write('\n> ');
  } else if (mode === 'jobs') {
    renderJobsList();
  } else if (mode === 'jobDetail') {
    renderJobDetail();
  } else if (mode === 'pipelines') {
    renderPipelinesList();
  } else if (mode === 'pipelineDetail') {
    renderPipelineDetail();
  }
}

function renderPipelinesList(): void {
  console.log(`${BOLD}Pipelines${RESET} (${state.pipelines.length} registered)`);
  if (state.pipelines.length === 0) {
    console.log(`  ${DIM}none — add .harness/config/pipelines.json${RESET}`);
  } else {
    state.pipelines.forEach((p, i) => {
      const num = `${i + 1}`.padStart(2);
      const phaseCount = (p.phases ?? []).length;
      const agents = uniqueAgents(p);
      console.log(`  ${BOLD}${num}.${RESET} ${p.id.padEnd(30)} ${DIM}${phaseCount} phases${RESET}  ${DIM}${agents.join(', ')}${RESET}`);
      if (p.description) {
        console.log(`      ${DIM}${p.description}${RESET}`);
      }
    });
  }
  console.log();
  console.log(`${DIM}commands:${RESET}`);
  console.log(`  ${BOLD}<n>${RESET} drill into pipeline #n`);
  console.log(`  ${BOLD}b${RESET} back   ${BOLD}q${RESET} quit`);
  process.stdout.write('\n> ');
}

function renderPipelineDetail(): void {
  const p = state.selectedPipeline;
  if (!p) {
    console.log(`${RED}(no pipeline selected)${RESET}`);
    process.stdout.write('\n> ');
    return;
  }
  console.log(`${BOLD}Pipeline${RESET}  ${p.id}`);
  if (p.name) console.log(`  ${DIM}name:${RESET}        ${p.name}`);
  if (p.description) console.log(`  ${DIM}description:${RESET} ${p.description}`);
  console.log();
  console.log(`  ${BOLD}phases (${(p.phases ?? []).length})${RESET}`);
  (p.phases ?? []).forEach((ph, i) => {
    const num = `${i + 1}.`.padEnd(3);
    const agentLabel = ph.agent ? `${CYAN}${ph.agent}${RESET}` : `${DIM}(no agent set)${RESET}`;
    const modelLabel = ph.model ? ` ${DIM}${ph.model}${RESET}` : '';
    const reasoning = ph.reasoningEffort ? `  ${DIM}reasoning=${ph.reasoningEffort}${RESET}` : '';
    console.log(`    ${num} ${BOLD}${ph.id.padEnd(14)}${RESET} ${agentLabel}${modelLabel}${reasoning}`);
    if (ph.description) {
      console.log(`        ${DIM}${ph.description}${RESET}`);
    }
    if (ph.tools && ph.tools.length) {
      console.log(`        ${DIM}tools:${RESET} ${ph.tools.join(', ')}`);
    }
  });
  console.log();
  console.log(`${DIM}commands:${RESET}`);
  console.log(`  ${BOLD}b${RESET} back to pipelines   ${BOLD}d${RESET} dashboard   ${BOLD}q${RESET} quit`);
  process.stdout.write('\n> ');
}

function uniqueAgents(p: PipelineConfig): string[] {
  const set = new Set<string>();
  for (const ph of p.phases ?? []) {
    if (ph.agent) set.add(ph.agent);
  }
  return [...set];
}

function renderJobsList(): void {
  console.log(`${BOLD}Active jobs${RESET} (${state.jobs.length})`);
  if (!state.trio.harness) {
    console.log(`  ${RED}harness-server is down — start it (pnpm dev:servers)${RESET}`);
  } else if (state.jobs.length === 0) {
    console.log(`  ${DIM}none yet — go back [b] then submit one with [s]${RESET}`);
  } else {
    state.jobs.forEach((j, i) => {
      const num = `${i + 1}`.padStart(2);
      const name = (j.name ?? '(unnamed)').padEnd(22).slice(0, 22);
      const product = (j.productId ?? '?').padEnd(16).slice(0, 16);
      const status = colorStatus(j.status);
      console.log(`  ${BOLD}${num}.${RESET} ${DIM}${j.jobId}${RESET}  ${name} ${product} ${status}`);
    });
  }
  console.log();
  console.log(`${DIM}commands:${RESET}`);
  console.log(`  ${BOLD}<n>${RESET} drill into job #n`);
  console.log(`  ${BOLD}r${RESET} refresh   ${BOLD}b${RESET} back   ${BOLD}q${RESET} quit`);
  process.stdout.write('\n> ');
}

function renderJobDetail(): void {
  const j = state.selectedJob;
  if (!j) {
    console.log(`${RED}(job detail not loaded)${RESET}`);
    process.stdout.write('\n> ');
    return;
  }
  console.log(`${BOLD}Job${RESET}  ${j.jobId}`);
  console.log(`  ${DIM}name:${RESET}        ${j.name ?? '(unnamed)'}`);
  console.log(`  ${DIM}status:${RESET}      ${colorStatus(j.status)}`);
  console.log(`  ${DIM}pipeline:${RESET}    ${j.pipeline ?? '?'}`);
  console.log(`  ${DIM}productId:${RESET}   ${j.productId ?? '?'}`);
  if (j.productRepos?.length) {
    console.log(`  ${DIM}repos:${RESET}       ${j.productRepos.join(', ')}`);
  }
  if (j.submittedAt) {
    console.log(`  ${DIM}submittedAt:${RESET} ${j.submittedAt}`);
  }
  if (j.input) {
    const lines = wrap(j.input, 60);
    console.log(`  ${DIM}input:${RESET}       ${lines[0]}`);
    for (const l of lines.slice(1)) console.log(`               ${l}`);
  }
  console.log();
  console.log(`${DIM}commands:${RESET}`);
  console.log(`  ${BOLD}r${RESET} refresh   ${BOLD}b${RESET} back to jobs   ${BOLD}q${RESET} quit`);
  process.stdout.write('\n> ');
}

function colorStatus(s: string | undefined): string {
  if (!s) return `${DIM}?${RESET}`;
  if (s === 'received') return `${GREEN}received${RESET}`;
  if (s === 'failed' || s === 'errored') return `${RED}${s}${RESET}`;
  if (s === 'cancelled' || s === 'rejected') return `${YELLOW}${s}${RESET}`;
  return s;
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if ((line + ' ' + word).length > width) {
      if (line) out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

function spawnAttached(cmd: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('close', (code) => resolve(code));
  });
}

function spawnCaptured(cmd: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c.toString()));
    child.stderr.on('data', (c) => (out += c.toString()));
    child.on('close', (code) => resolve({ code, out }));
  });
}

function harnessCli(...args: string[]): string[] {
  return ['--silent', '--filter', '@agentx/harness-cli', 'exec', 'tsx', 'src/index.ts', ...args];
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

// Buffer any lines that arrive before initial refreshAll() finishes (e.g.,
// piped non-TTY input in CI). Interactive tmux usage doesn't hit this case
// since user input lags behind startup, but the guard makes both paths safe.
let initialized = false;
const pendingLines: string[] = [];

async function handleLine(raw: string): Promise<void> {
  const line = raw.trim();
  if (mode === 'menu') {
    const cmd = line.toLowerCase();
    if (cmd === 'q' || cmd === 'quit') {
      console.log('bye.');
      rl.close();
      process.exit(0);
    } else if (cmd === 'r') {
      await refreshAll();
      render();
    } else if (cmd === 'l' && !state.authenticated) {
      process.stdout.write(`\n${YELLOW}→ GitHub Device Flow — follow the URL + code below${RESET}\n\n`);
      rl.pause();
      await spawnAttached('pnpm', harnessCli('auth', 'login', 'github-copilot'));
      rl.resume();
      mode = 'awaitingLoginReturn';
      render();
    } else if (cmd === 's' && state.authenticated) {
      if (state.pipelines.length === 0) {
        process.stdout.write(
          `\n${RED}No pipelines registered. Add .harness/config/pipelines.json.${RESET}\n\n`
        );
        process.stdout.write('press Enter to continue…');
        return;
      }
      mode = 'awaitingPipelinePick';
      render();
    } else if (cmd === 'p' && state.authenticated) {
      if (state.productList.length === 0) {
        await refreshAll();
      }
      mode = 'awaitingProductPick';
      render();
    } else if (cmd === 'j') {
      mode = 'jobs';
      await refreshJobs();
      render();
    } else if (line === 'L') {
      mode = 'pipelines';
      render();
    } else {
      // Unknown command — just redraw
      render();
    }
  } else if (mode === 'jobs') {
    if (line === '' || line === 'b' || line === 'd') {
      mode = 'menu';
      render();
      return;
    }
    if (line === 'q') {
      console.log('bye.');
      rl.close();
      process.exit(0);
    }
    if (line === 'r') {
      await refreshJobs();
      render();
      return;
    }
    const idx = parseInt(line, 10);
    if (idx >= 1 && idx <= state.jobs.length) {
      const summary = state.jobs[idx - 1]!;
      const detail = await loadJobDetail(summary.jobId);
      state.selectedJob = detail ?? summary;
      mode = 'jobDetail';
      render();
      return;
    }
    render();
  } else if (mode === 'jobDetail') {
    if (line === '' || line === 'b') {
      state.selectedJob = null;
      mode = 'jobs';
      await refreshJobs();
      render();
      return;
    }
    if (line === 'd') {
      state.selectedJob = null;
      mode = 'menu';
      render();
      return;
    }
    if (line === 'r' && state.selectedJob) {
      const refreshed = await loadJobDetail(state.selectedJob.jobId);
      if (refreshed) state.selectedJob = refreshed;
      render();
      return;
    }
    if (line === 'q') {
      console.log('bye.');
      rl.close();
      process.exit(0);
    }
    render();
  } else if (mode === 'awaitingPipelinePick') {
    if (line.length === 0) {
      mode = 'menu';
      state.pendingPipelineId = null;
      render();
      return;
    }
    const idx = parseInt(line, 10);
    if (!(idx >= 1 && idx <= state.pipelines.length)) {
      // invalid choice, redraw the picker
      render();
      return;
    }
    state.pendingPipelineId = state.pipelines[idx - 1]!.id;
    mode = 'awaitingIntent';
    render();
  } else if (mode === 'awaitingIntent') {
    if (line.length === 0) {
      mode = 'menu';
      state.pendingPipelineId = null;
      render();
      return;
    }
    state.busy = 'submitting…';
    render();
    const name = line.length < 40 ? line : line.slice(0, 37) + '…';
    const pipelineId = state.pendingPipelineId ?? 'feature-add';
    const { out } = await spawnCaptured(
      'pnpm',
      harnessCli('submit', pipelineId, '--product', state.productId, '--name', name, '--input-text', line)
    );
    const m = out.match(/job_[a-f0-9]+/);
    state.recentJobs = [
      ...state.recentJobs,
      `${m?.[0] ?? '???'} [${pipelineId}] ${name}`,
    ].slice(-5);
    state.busy = null;
    state.pendingPipelineId = null;
    mode = 'menu';
    await refreshAll();
    render();
  } else if (mode === 'awaitingProductPick') {
    const idx = parseInt(line, 10);
    if (idx >= 1 && idx <= state.productList.length) {
      const picked = state.productList[idx - 1]!;
      await spawnCaptured('pnpm', harnessCli('session', 'set', 'productId', picked));
    }
    mode = 'menu';
    await refreshAll();
    render();
  } else if (mode === 'awaitingLoginReturn') {
    mode = 'menu';
    await refreshAll();
    render();
  } else if (mode === 'pipelines') {
    if (line === '' || line === 'b' || line === 'd') {
      mode = 'menu';
      render();
      return;
    }
    if (line === 'q') {
      console.log('bye.');
      rl.close();
      process.exit(0);
    }
    const idx = parseInt(line, 10);
    if (idx >= 1 && idx <= state.pipelines.length) {
      state.selectedPipeline = state.pipelines[idx - 1]!;
      mode = 'pipelineDetail';
      render();
      return;
    }
    render();
  } else if (mode === 'pipelineDetail') {
    if (line === '' || line === 'b') {
      state.selectedPipeline = null;
      mode = 'pipelines';
      render();
      return;
    }
    if (line === 'd') {
      state.selectedPipeline = null;
      mode = 'menu';
      render();
      return;
    }
    if (line === 'q') {
      console.log('bye.');
      rl.close();
      process.exit(0);
    }
    render();
  }
}

rl.on('line', (raw) => {
  if (!initialized) {
    pendingLines.push(raw);
    return;
  }
  void handleLine(raw);
});

// First paint
await refreshAll();
render();
initialized = true;
while (pendingLines.length > 0) {
  await handleLine(pendingLines.shift()!);
}

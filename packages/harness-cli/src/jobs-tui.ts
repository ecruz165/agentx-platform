import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Envelope, RegisteredAgent } from '@agentx/harness-server';
import { connectSseStream } from './sse-client.ts';
import { udsRequest } from './uds-client.ts';

/**
 * Three-column jobs viewer.
 *
 *   ┌─ Jobs ──────────┬─ Agents ─────────────┬─ Events / detail ──────┐
 *   │ ▸ #abc passkey  │ skoolscout-com  ●    │ name:      Office Hours │
 *   │   #def spring   │ jefelabs-com    ●    │ pipeline:  feature-add  │
 *   │   #ghi mtauth ✓ │                      │ submitted: 2026-05-01…  │
 *   │                 │                      │ input:     <wrap>       │
 *   ├─────────────────┼──────────────────────┼─────────────────────────┤
 *   │ N active        │ M agents             │ MVP-3 will stream live  │
 *   └─────────────────┴──────────────────────┴─────────────────────────┘
 *     j/k or ↑↓ nav  enter drill  r refresh  m main  q quit
 *
 * MVP-1 honesty: there's no agent fan-out yet, so the middle column shows
 * the product's repos (each is one agent's territory). The right column
 * shows the job's stored body fields rather than a live event stream.
 * When MVP-3+ adds SSE + per-agent state, the columns wire to those.
 */

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

const WS_ROOT = findWorkspaceRoot();
const HARNESS_SOCKET = join(WS_ROOT, '.harness', 'run', 'harness.sock');
const TMUX_SESSION = process.env.AGENTX_TMUX_SESSION ?? 'agentx';
const POLL_MS = 3000;

interface JobSummary {
  jobId: string;
  name?: string;
  pipeline?: string;
  productId?: string;
  productRepos?: string[];
  status?: string;
  submittedAt?: string;
  input?: string;
  agents?: RegisteredAgent[];
}

const EVENT_BUFFER_CAP = 200;

const state = {
  jobs: [] as JobSummary[],
  selectedIndex: 0,
  selectedDetail: null as JobSummary | null,
  selectedJobId: null as string | null,
  events: [] as Envelope[], // newest at end, capped at EVENT_BUFFER_CAP
  sseUnsubscribe: null as (() => void) | null,
  error: null as string | null,
  loading: true,
};

// ANSI
const ESC = '\x1b';
const CLEAR = `${ESC}[2J`;
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const REV = `${ESC}[7m`;
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;
const YELLOW = `${ESC}[33m`;
const CYAN = `${ESC}[36m`;
const move = (r: number, c: number) => `${ESC}[${r};${c}H`;

function dims() {
  return {
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80,
  };
}

async function fetchJobs(): Promise<JobSummary[]> {
  const resp = await udsRequest(HARNESS_SOCKET, 'GET', '/v1/jobs');
  const body = resp.body as { ok?: boolean; jobs?: JobSummary[] } | null;
  return body?.jobs ?? [];
}

async function fetchDetail(id: string): Promise<JobSummary | null> {
  const resp = await udsRequest(HARNESS_SOCKET, 'GET', `/v1/jobs/${id}`);
  const body = resp.body as { ok?: boolean; job?: JobSummary } | null;
  return body?.job ?? null;
}

/**
 * Switches the live SSE subscription to track `jobId`. Buffer is reset on
 * every switch so the right column shows only the selected job's stream.
 * No-op when `jobId` matches the currently-tracked job.
 */
function attachSse(jobId: string): void {
  if (state.selectedJobId === jobId && state.sseUnsubscribe) return;
  detachSse();
  state.selectedJobId = jobId;
  state.events = [];
  state.sseUnsubscribe = connectSseStream<Envelope>(
    HARNESS_SOCKET,
    `/v1/jobs/${jobId}/events`,
    (envelope) => {
      state.events.push(envelope);
      if (state.events.length > EVENT_BUFFER_CAP) {
        state.events.splice(0, state.events.length - EVENT_BUFFER_CAP);
      }
      render();
    },
    (err) => {
      state.error = `SSE: ${err.message}`;
      render();
    }
  );
}

function detachSse(): void {
  if (state.sseUnsubscribe) {
    try {
      state.sseUnsubscribe();
    } catch {
      // ignore
    }
    state.sseUnsubscribe = null;
  }
}

async function refresh(): Promise<void> {
  if (!existsSync(HARNESS_SOCKET)) {
    state.jobs = [];
    state.selectedDetail = null;
    detachSse();
    state.error = 'harness-server is down — start it with pnpm tmux';
    return;
  }
  try {
    state.jobs = await fetchJobs();
    state.error = null;
    if (state.jobs.length === 0) {
      state.selectedDetail = null;
      detachSse();
      return;
    }
    if (state.selectedIndex >= state.jobs.length) {
      state.selectedIndex = state.jobs.length - 1;
    }
    const id = state.jobs[state.selectedIndex]!.jobId;
    state.selectedDetail = await fetchDetail(id);
    attachSse(id);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  }
}

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w);
  return s + ' '.repeat(w - s.length);
}

function trunc(s: string, w: number): string {
  return s.length <= w ? s : s.slice(0, Math.max(0, w - 1)) + '…';
}

function statusColor(s?: string): string {
  if (s === 'received') return GREEN + s + RESET;
  if (s === 'failed' || s === 'errored') return RED + s + RESET;
  if (s === 'cancelled' || s === 'rejected') return YELLOW + s + RESET;
  return DIM + (s ?? '?') + RESET;
}

function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if ((line + ' ' + word).trim().length > w) {
      if (line) out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

function render(): void {
  const { rows, cols } = dims();
  // Column widths (left + middle + right = cols, after borders)
  const leftW = Math.max(18, Math.floor(cols * 0.22));
  const midW = Math.max(24, Math.floor(cols * 0.30));
  const rightW = cols - leftW - midW - 4; // 4 = borders/separators

  let out = HIDE + CLEAR + move(1, 1);

  // ── Top border row ──
  out += '┌─ ' + BOLD + 'Jobs' + RESET + ' ' + '─'.repeat(leftW - 7);
  out += '┬─ ' + BOLD + 'Agents' + RESET + ' ' + '─'.repeat(midW - 9);
  if (state.selectedDetail?.jobId) {
    const title = `Events · ${state.selectedDetail.jobId}`;
    out += '┬─ ' + BOLD + trunc(title, rightW - 2) + RESET + ' ' + '─'.repeat(Math.max(0, rightW - title.length - 4));
  } else {
    out += '┬─ ' + BOLD + 'Events' + RESET + ' ' + '─'.repeat(rightW - 9);
  }
  out += '┐\n';

  // ── Body rows ──
  const bodyRows = rows - 4; // header + footer + separator + hint = 4
  const leftLines = renderJobsCol(bodyRows);
  const midLines = renderAgentsCol(bodyRows);
  const rightLines = renderEventsCol(bodyRows);

  for (let i = 0; i < bodyRows; i++) {
    out += '│' + (leftLines[i] ?? ' '.repeat(leftW));
    out += '│' + (midLines[i] ?? ' '.repeat(midW));
    out += '│' + (rightLines[i] ?? ' '.repeat(rightW));
    out += '│\n';
  }

  // ── Footer separator ──
  out += '├' + '─'.repeat(leftW) + '┼' + '─'.repeat(midW) + '┼' + '─'.repeat(rightW) + '┤\n';

  // ── Footer summary ──
  const leftFoot = ` ${state.jobs.length} active`;
  const midFoot = state.selectedDetail?.agents
    ? ` ${state.selectedDetail.agents.length} agents`
    : ' —';
  const rightFoot = state.error
    ? ` ${RED}${trunc(state.error, rightW - 2)}${RESET}`
    : state.loading
      ? ` ${YELLOW}loading…${RESET}`
      : state.sseUnsubscribe
        ? ` ${GREEN}● live${RESET}  ${DIM}${state.events.length} events buffered${RESET}`
        : ` ${DIM}— no stream${RESET}`;
  out += '│' + visualPad(leftFoot, leftW);
  out += '│' + visualPad(midFoot, midW);
  out += '│' + visualPad(rightFoot, rightW);
  out += '│\n';

  out += '└' + '─'.repeat(leftW) + '┴' + '─'.repeat(midW) + '┴' + '─'.repeat(rightW) + '┘\n';

  // ── Hint line ──
  out += DIM + ' j/k or ↑↓ nav   enter drill   r refresh   m main   q quit' + RESET;

  process.stdout.write(out);
}

// Visual width = char count for ASCII; ANSI escapes don't take width.
function visualPad(s: string, w: number): string {
  // strip ANSI escapes for length calculation
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  if (visible.length >= w) return s; // assume caller already truncated
  return s + ' '.repeat(w - visible.length);
}

function renderJobsCol(bodyRows: number): string[] {
  const lines: string[] = [];
  const w = Math.max(18, Math.floor(dims().cols * 0.22));
  if (state.jobs.length === 0) {
    lines.push(visualPad(`  ${DIM}(no jobs yet)${RESET}`, w));
    return lines;
  }
  // Window into jobs around selectedIndex
  const start = Math.max(0, Math.min(state.selectedIndex - Math.floor(bodyRows / 2), state.jobs.length - bodyRows));
  for (let i = 0; i < Math.min(bodyRows, state.jobs.length - start); i++) {
    const idx = start + i;
    const j = state.jobs[idx]!;
    const marker = idx === state.selectedIndex ? `${CYAN}▸${RESET}` : ' ';
    const id = j.jobId.startsWith('job_') ? '#' + j.jobId.slice(4, 11) : j.jobId.slice(0, 8);
    const name = trunc(j.name ?? '(unnamed)', w - 12);
    const tick = j.status === 'completed' ? ` ${GREEN}✓${RESET}` : '';
    const text = ` ${marker} ${DIM}${id}${RESET} ${name}${tick}`;
    lines.push(visualPad(text, w));
  }
  return lines;
}

function renderAgentsCol(bodyRows: number): string[] {
  const lines: string[] = [];
  const w = Math.max(24, Math.floor(dims().cols * 0.30));
  const job = state.selectedDetail;
  if (!job) {
    lines.push(visualPad(`  ${DIM}(no job selected)${RESET}`, w));
    return lines;
  }
  lines.push(visualPad(`  ${DIM}pipeline:${RESET} ${trunc(job.pipeline ?? '?', w - 12)}`, w));
  lines.push(visualPad(`  ${DIM}product:${RESET}  ${trunc(job.productId ?? '?', w - 12)}`, w));
  lines.push(visualPad('', w));

  const agents = job.agents ?? [];
  if (agents.length === 0) {
    lines.push(visualPad(`  ${DIM}(no agents registered)${RESET}`, w));
    while (lines.length < bodyRows) lines.push(visualPad('', w));
    return lines;
  }

  lines.push(visualPad(`  ${BOLD}agent${RESET}             role        status`, w));
  for (const agent of agents) {
    const dot = agentStatusColor(agent.status);
    const id = trunc(agent.id, 16).padEnd(16);
    const role = trunc(agent.role, 10).padEnd(10);
    const text = `  ${dot} ${id} ${DIM}${role}${RESET} ${agentStatusColor(agent.status)} ${DIM}${agent.status}${RESET}`;
    lines.push(visualPad(text, w));
  }
  while (lines.length < bodyRows) lines.push(visualPad('', w));
  return lines;
}

function agentStatusColor(status: string): string {
  if (status === 'completed') return `${GREEN}●${RESET}`;
  if (status === 'failed') return `${RED}●${RESET}`;
  if (status === 'running') return `${CYAN}●${RESET}`;
  return `${DIM}○${RESET}`;
}

function renderEventsCol(bodyRows: number): string[] {
  const lines: string[] = [];
  const cols = dims().cols;
  const leftW = Math.max(18, Math.floor(cols * 0.22));
  const midW = Math.max(24, Math.floor(cols * 0.30));
  const w = cols - leftW - midW - 4;
  const job = state.selectedDetail;
  if (!job) {
    lines.push(visualPad(`  ${DIM}(no job selected)${RESET}`, w));
    return lines;
  }
  const kv = (k: string, v: string) => visualPad(`  ${DIM}${pad(k, 12)}${RESET}${trunc(v, w - 14)}`, w);
  lines.push(kv('jobId:', job.jobId));
  lines.push(kv('status:', job.status ?? '?'));
  lines.push(kv('submitted:', job.submittedAt ?? '?'));
  lines.push(visualPad('', w));
  lines.push(visualPad(`  ${BOLD}live events${RESET} ${DIM}(${state.events.length})${RESET}`, w));

  const eventLines = state.events.map(formatEventLine);
  // Show the most recent events that fit in the remaining body rows.
  const slotsLeft = Math.max(0, bodyRows - lines.length);
  const visible = eventLines.slice(-slotsLeft);
  if (visible.length === 0) {
    lines.push(visualPad(`  ${DIM}(awaiting events…)${RESET}`, w));
  } else {
    for (const line of visible) {
      lines.push(visualPad(trunc(line, w), w));
    }
  }
  while (lines.length < bodyRows) lines.push(visualPad('', w));
  return lines;
}

function formatEventLine(envelope: Envelope): string {
  const ts = envelope.event.ts.replace(/^.*T(\d\d:\d\d:\d\d).*$/, '$1');
  const agent = trunc(envelope.agentId, 12).padEnd(12);
  const kind = envelope.event.kind;
  const kindColor = kind === 'error' ? RED : kind === 'response' ? GREEN : CYAN;
  let preview = '';
  if (envelope.event.kind === 'request') {
    preview = trunc(envelope.event.user.replace(/\s+/g, ' '), 80);
  } else if (envelope.event.kind === 'response') {
    preview = trunc(envelope.event.text.replace(/\s+/g, ' '), 80);
  } else if (envelope.event.kind === 'error') {
    preview = trunc(envelope.event.message, 80);
  }
  return `  ${DIM}${ts}${RESET} ${agent} ${kindColor}${pad(kind, 8)}${RESET} ${preview}`;
}

// ── Input handling (raw mode) ──
let exiting = false;

function teardown(): void {
  if (exiting) return;
  exiting = true;
  detachSse();
  process.stdout.write(SHOW + RESET);
  if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
}

function quit(): void {
  teardown();
  process.exit(0);
}

function goToMain(): void {
  // Switch tmux window without exiting — process keeps running.
  spawn('tmux', ['select-window', '-t', `${TMUX_SESSION}:dash`], { stdio: 'ignore' })
    .on('error', () => {});
}

function moveDown(): void {
  if (state.selectedIndex < state.jobs.length - 1) {
    state.selectedIndex++;
    render();
    void refreshDetail();
  }
}

function moveUp(): void {
  if (state.selectedIndex > 0) {
    state.selectedIndex--;
    render();
    void refreshDetail();
  }
}

async function refreshDetail(): Promise<void> {
  if (state.jobs.length === 0) return;
  const id = state.jobs[state.selectedIndex]!.jobId;
  state.selectedDetail = await fetchDetail(id).catch(() => null);
  attachSse(id);
  render();
}

if (process.stdin.isTTY && process.stdin.setRawMode) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.setEncoding('utf8');

process.stdin.on('data', async (chunk: string) => {
  // Handle multi-byte sequences (arrow keys arrive as ESC [ A/B)
  for (const key of splitKeys(chunk)) {
    if (key === '' || key === 'q') quit();
    else if (key === 'm') goToMain();
    else if (key === 'r' || key === '\r') {
      state.loading = true;
      render();
      await refresh();
      state.loading = false;
      render();
    } else if (key === 'j' || key === '[B') moveDown();
    else if (key === 'k' || key === '[A') moveUp();
  }
});

function splitKeys(s: string): string[] {
  // Coarse split: ESC sequences are at most 3-4 chars (ESC [ X).
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '' && s[i + 1] === '[') {
      out.push(s.slice(i, i + 3));
      i += 3;
    } else {
      out.push(s[i]!);
      i++;
    }
  }
  return out;
}

process.on('SIGINT', quit);
process.on('SIGTERM', quit);
process.on('exit', teardown);
process.stdout.on('resize', render);

// ── First paint + polling ──
await refresh();
render();
setInterval(async () => {
  await refresh();
  render();
}, POLL_MS);

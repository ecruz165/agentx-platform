/** @jsxImportSource @opentui/react */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AuthStore } from '@agentx/agent-auth-lib';
import { createCliRenderer } from '@opentui/core';
import { createRoot, useKeyboard, useOnResize, useRenderer } from '@opentui/react';
import { useCallback, useEffect, useState } from 'react';
import YAML from 'yaml';
import { udsRequest } from './uds-client.ts';
import { type PipelineConfig, readPipelines } from './workspace-config.ts';

/**
 * agentx ops dashboard — OpenTUI port of the original ANSI/readline TUI.
 *
 * Behaviors preserved:
 *   - Auth status (~/.agentx/auth.json); peer-server socket presence;
 *     active product (session.json); workspace product list (yml); pipeline
 *     catalog (.harness/config/pipelines.json); recent submissions.
 *   - Modes: menu / pipeline-pick / intent / product-pick / login-return /
 *     jobs / job-detail / pipelines / pipeline-detail
 *   - Login subprocess: suspends the renderer, spawns
 *     `pnpm harness auth login github-copilot` with stdio:inherit, resumes.
 *   - Submit flow: pick pipeline → type intent → spawn `harness submit ...`,
 *     parse job id from captured output, append to recent list.
 *   - Product pick: spawn `harness session set productId <picked>`.
 *
 * Renders declaratively via OpenTUI React. No manual ANSI / readline.
 */

// ─── workspace + paths ────────────────────────────────────────────────────
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

const ORG_DIR = join(homedir(), '.agentx');
const AUTH_PATH = join(ORG_DIR, 'auth.json');
const SESSION_PATH = join(ORG_DIR, 'session.json');
const WORKSPACE_ROOT = findWorkspaceRoot();
const RUN_DIR = join(WORKSPACE_ROOT, '.harness', 'run');
const HARNESS_SOCKET = join(RUN_DIR, 'harness.sock');
const YAML_PATH = join(WORKSPACE_ROOT, 'harness-workspace.yml');

// ─── types ────────────────────────────────────────────────────────────────

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

interface AuthInfo {
  authenticated: boolean;
  username?: string;
  copilotSessionExpiresIn?: number;
}

interface TrioState {
  harness: boolean;
  memory: boolean;
  context: boolean;
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

// ─── data loaders (pure async, no UI coupling) ────────────────────────────

async function loadAuth(): Promise<AuthInfo> {
  try {
    const store = new AuthStore(AUTH_PATH);
    const s = await store.status();
    const cp = s['github-copilot'];
    return {
      authenticated: !!cp?.authenticated,
      username: cp?.username,
      copilotSessionExpiresIn: cp?.copilotSessionExpiresIn,
    };
  } catch {
    return { authenticated: false };
  }
}

async function loadProductId(): Promise<string> {
  try {
    const session = JSON.parse(await readFile(SESSION_PATH, 'utf8'));
    return session.productId ?? '(unset)';
  } catch {
    return '(unset)';
  }
}

async function loadProductList(): Promise<string[]> {
  try {
    const cfg = YAML.parse(await readFile(YAML_PATH, 'utf8')) as {
      workspace: { products: Array<{ id: string }> };
    };
    return cfg.workspace.products.map((p) => p.id);
  } catch {
    return [];
  }
}

async function loadPipelinesList(): Promise<PipelineConfig[]> {
  try {
    const catalog = await readPipelines(WORKSPACE_ROOT);
    return catalog?.pipelines ?? [];
  } catch {
    return [];
  }
}

function checkTrio(): TrioState {
  return {
    harness: existsSync(HARNESS_SOCKET),
    memory: existsSync(join(RUN_DIR, 'memory.sock')),
    context: existsSync(join(RUN_DIR, 'context.sock')),
  };
}

async function loadJobsList(trioHarness: boolean): Promise<JobSummary[]> {
  if (!trioHarness) return [];
  try {
    const resp = await udsRequest(HARNESS_SOCKET, 'GET', '/v1/jobs');
    const body = resp.body as { ok?: boolean; jobs?: JobSummary[] } | null;
    return body?.jobs ?? [];
  } catch {
    return [];
  }
}

async function loadJobDetail(id: string): Promise<JobSummary | null> {
  try {
    const resp = await udsRequest(HARNESS_SOCKET, 'GET', `/v1/jobs/${id}`);
    const body = resp.body as { ok?: boolean; job?: JobSummary } | null;
    return body?.job ?? null;
  } catch {
    return null;
  }
}

// ─── subprocess helpers ───────────────────────────────────────────────────

function harnessCli(...args: string[]): string[] {
  return ['--silent', 'harness', ...args];
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

// ─── pure UI helpers ──────────────────────────────────────────────────────

function statusFg(s?: string): string {
  if (s === 'received' || s === 'completed') return '#4ade80';
  if (s === 'failed' || s === 'errored') return '#f87171';
  if (s === 'cancelled' || s === 'rejected') return '#facc15';
  if (s === 'running') return '#06b6d4';
  return '#9ca3af';
}

function uniqueAgents(p: PipelineConfig): string[] {
  const set = new Set<string>();
  for (const ph of p.phases ?? []) {
    if (ph.agent) set.add(ph.agent);
  }
  return [...set];
}

function trunc(s: string, w: number): string {
  return s.length <= w ? s : `${s.slice(0, Math.max(0, w - 1))}…`;
}

// ─── useDims hook (workaround for OpenTUI 0.2.2 first-render dims=0) ─────
function useDims(): { width: number; height: number } {
  const renderer = useRenderer();
  const measure = (): { width: number; height: number } => ({
    width: renderer.width || process.stdout.columns || 80,
    height: renderer.height || process.stdout.rows || 24,
  });
  const [dims, setDims] = useState(measure);
  useEffect(() => {
    setDims(measure());
    // biome-ignore lint/correctness/useExhaustiveDependencies: measure is component-scoped; intentionally unstable to re-read terminal dims on every re-mount of the consumer
  }, [measure]);
  useOnResize((w, h) => {
    setDims({
      width: w || process.stdout.columns || 80,
      height: h || process.stdout.rows || 24,
    });
  });
  return dims;
}

// ─── App ──────────────────────────────────────────────────────────────────

function App() {
  const dims = useDims();
  const renderer = useRenderer();

  const [mode, setMode] = useState<Mode>('menu');
  const [auth, setAuth] = useState<AuthInfo>({ authenticated: false });
  const [productId, setProductId] = useState('(unset)');
  const [productList, setProductList] = useState<string[]>([]);
  const [trio, setTrio] = useState<TrioState>({
    harness: false,
    memory: false,
    context: false,
  });
  const [pipelines, setPipelines] = useState<PipelineConfig[]>([]);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [recentJobs, setRecentJobs] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<JobSummary | null>(null);
  const [selectedPipeline, setSelectedPipeline] = useState<PipelineConfig | null>(null);
  const [pendingPipelineId, setPendingPipelineId] = useState<string | null>(null);
  const [inputBuffer, setInputBuffer] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);

  const refreshAll = useCallback(async () => {
    const [a, pid, plist, plist2] = await Promise.all([
      loadAuth(),
      loadProductId(),
      loadProductList(),
      loadPipelinesList(),
    ]);
    setAuth(a);
    setProductId(pid);
    setProductList(plist);
    setPipelines(plist2);
    const t = checkTrio();
    setTrio(t);
    setJobs(await loadJobsList(t.harness));
  }, []);

  const refreshJobs = useCallback(async () => {
    const t = checkTrio();
    setTrio(t);
    setJobs(await loadJobsList(t.harness));
  }, []);

  // Initial load
  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // Login flow: suspend renderer, spawn attached, resume on exit.
  const runLogin = useCallback(async () => {
    setBusy('logging in via GitHub…');
    renderer.suspend();
    process.stdout.write('\n→ GitHub Device Flow — follow the URL + code below\n\n');
    await spawnAttached('pnpm', harnessCli('auth', 'login', 'github-copilot'));
    renderer.resume();
    setBusy(null);
    setMode('awaitingLoginReturn');
  }, [renderer]);

  // Submit flow: spawn captured, parse job id from output.
  const runSubmit = useCallback(
    async (intent: string) => {
      setBusy('submitting…');
      const name = intent.length < 40 ? intent : `${intent.slice(0, 37)}…`;
      const pipelineId = pendingPipelineId ?? 'feature-add';
      const { out } = await spawnCaptured(
        'pnpm',
        harnessCli(
          'submit',
          pipelineId,
          '--product',
          productId,
          '--name',
          name,
          '--input-text',
          intent,
        ),
      );
      const m = out.match(/job_[a-f0-9]+/);
      setRecentJobs((prev) => [...prev, `${m?.[0] ?? '???'} [${pipelineId}] ${name}`].slice(-5));
      setBusy(null);
      setPendingPipelineId(null);
      setMode('menu');
      await refreshAll();
    },
    [pendingPipelineId, productId, refreshAll],
  );

  // Product pick: spawn session-set, then refresh.
  const runProductPick = useCallback(
    async (picked: string) => {
      setBusy(`switching product → ${picked}…`);
      await spawnCaptured('pnpm', harnessCli('session', 'set', 'productId', picked));
      setBusy(null);
      setMode('menu');
      await refreshAll();
    },
    [refreshAll],
  );

  // Centralized key handler — dispatches by mode. Picker/intent modes use
  // the inputBuffer state for accumulated typing.
  useKeyboard((e) => {
    // Universal: Ctrl+C exits (also handled by exitOnCtrlC: true)
    if (e.name === 'q' && mode !== 'awaitingIntent') {
      // 'q' as a literal char only quits when not typing free text
      if (
        mode === 'menu' ||
        mode === 'jobs' ||
        mode === 'jobDetail' ||
        mode === 'pipelines' ||
        mode === 'pipelineDetail'
      ) {
        process.exit(0);
      }
    }

    if (mode === 'menu') {
      if (e.name === 'r') void refreshAll();
      else if (e.name === 'l' && !auth.authenticated) void runLogin();
      else if (e.name === 's' && auth.authenticated) {
        if (pipelines.length === 0) {
          setInputError('No pipelines registered');
          return;
        }
        setInputBuffer('');
        setInputError(null);
        setMode('awaitingPipelinePick');
      } else if (e.name === 'p' && auth.authenticated) {
        setInputBuffer('');
        setInputError(null);
        setMode('awaitingProductPick');
      } else if (e.name === 'j') {
        setMode('jobs');
        void refreshJobs();
      } else if (e.name === 'l' && e.shift) {
        // Shift+L for pipelines list (the original used capital L)
        setMode('pipelines');
      }
    } else if (mode === 'jobs') {
      if (e.name === 'b' || e.name === 'd' || e.name === 'escape') {
        setMode('menu');
      } else if (e.name === 'r') {
        void refreshJobs();
      } else if (e.name === 'return') {
        // No-op for now; could use this to drill into highlighted job
      } else if (/^[1-9]$/.test(e.name) || /^[0-9]$/.test(e.name)) {
        // Single-digit job pick (limit: 9 jobs)
        const idx = parseInt(e.name, 10) - 1;
        if (idx >= 0 && idx < jobs.length) {
          const summary = jobs[idx]!;
          void loadJobDetail(summary.jobId).then((detail) => {
            setSelectedJob(detail ?? summary);
            setMode('jobDetail');
          });
        }
      }
    } else if (mode === 'jobDetail') {
      if (e.name === 'b' || e.name === 'escape') {
        setSelectedJob(null);
        setMode('jobs');
        void refreshJobs();
      } else if (e.name === 'd') {
        setSelectedJob(null);
        setMode('menu');
      } else if (e.name === 'r' && selectedJob) {
        void loadJobDetail(selectedJob.jobId).then((d) => {
          if (d) setSelectedJob(d);
        });
      }
    } else if (mode === 'pipelines') {
      if (e.name === 'b' || e.name === 'd' || e.name === 'escape') {
        setMode('menu');
      } else if (/^[1-9]$/.test(e.name)) {
        const idx = parseInt(e.name, 10) - 1;
        if (idx >= 0 && idx < pipelines.length) {
          setSelectedPipeline(pipelines[idx]!);
          setMode('pipelineDetail');
        }
      }
    } else if (mode === 'pipelineDetail') {
      if (e.name === 'b' || e.name === 'escape') {
        setSelectedPipeline(null);
        setMode('pipelines');
      } else if (e.name === 'd') {
        setSelectedPipeline(null);
        setMode('menu');
      }
    } else if (mode === 'awaitingLoginReturn') {
      if (e.name === 'return' || e.name === 'escape') {
        setMode('menu');
        void refreshAll();
      }
    } else if (mode === 'awaitingPipelinePick') {
      if (e.name === 'escape') {
        setInputBuffer('');
        setMode('menu');
      } else if (e.name === 'return') {
        const idx = parseInt(inputBuffer, 10) - 1;
        if (idx >= 0 && idx < pipelines.length) {
          setPendingPipelineId(pipelines[idx]!.id);
          setInputBuffer('');
          setInputError(null);
          setMode('awaitingIntent');
        } else {
          setInputError('Invalid pipeline number');
          setInputBuffer('');
        }
      } else if (e.name === 'backspace') {
        setInputBuffer((s) => s.slice(0, -1));
      } else if (/^[0-9]$/.test(e.name)) {
        setInputBuffer((s) => s + e.name);
      }
    } else if (mode === 'awaitingProductPick') {
      if (e.name === 'escape') {
        setInputBuffer('');
        setMode('menu');
      } else if (e.name === 'return') {
        const idx = parseInt(inputBuffer, 10) - 1;
        if (idx >= 0 && idx < productList.length) {
          const picked = productList[idx]!;
          setInputBuffer('');
          void runProductPick(picked);
        } else {
          setInputError('Invalid product number');
          setInputBuffer('');
        }
      } else if (e.name === 'backspace') {
        setInputBuffer((s) => s.slice(0, -1));
      } else if (/^[0-9]$/.test(e.name)) {
        setInputBuffer((s) => s + e.name);
      }
    } else if (mode === 'awaitingIntent') {
      if (e.name === 'escape') {
        setInputBuffer('');
        setPendingPipelineId(null);
        setMode('menu');
      } else if (e.name === 'return') {
        const text = inputBuffer.trim();
        if (text.length === 0) {
          setPendingPipelineId(null);
          setMode('menu');
        } else {
          setInputBuffer('');
          void runSubmit(text);
        }
      } else if (e.name === 'backspace') {
        setInputBuffer((s) => s.slice(0, -1));
      } else if (e.name === 'space') {
        setInputBuffer((s) => `${s} `);
      } else if (e.sequence && e.sequence.length === 1 && !e.ctrl && !e.meta) {
        // Accept any single printable character
        setInputBuffer((s) => s + e.sequence);
      }
    }
  });

  if (dims.width === 0 || dims.height === 0) return null;

  return (
    <box
      flexDirection="column"
      width={dims.width}
      height={dims.height}
      paddingLeft={1}
      paddingRight={1}
    >
      <Header />

      {/* Scrollable status block — fills remaining vertical space.
          The prompt area below stays anchored at the bottom. */}
      <scrollbox flexGrow={1} flexDirection="column">
        <AuthSection auth={auth} />
        <SectionGap />
        <PeerServersSection trio={trio} />
        <SectionGap />
        <ActiveProductSection productId={productId} />
        {pipelines.length > 0 ? (
          <>
            <SectionGap />
            <PipelinesSummary pipelines={pipelines} />
          </>
        ) : null}
        {recentJobs.length > 0 ? (
          <>
            <SectionGap />
            <RecentJobsSection items={recentJobs} />
          </>
        ) : null}
        {busy ? (
          <>
            <SectionGap />
            <text fg="#facc15">⏳ {busy}</text>
          </>
        ) : null}
      </scrollbox>

      <box flexDirection="column" flexShrink={0}>
        <Separator />
        <PromptArea
          mode={mode}
          auth={auth}
          jobs={jobs}
          pipelines={pipelines}
          productList={productList}
          recentJobs={recentJobs}
          selectedJob={selectedJob}
          selectedPipeline={selectedPipeline}
          pendingPipelineId={pendingPipelineId}
          inputBuffer={inputBuffer}
          inputError={inputError}
        />
      </box>
    </box>
  );
}

// ─── header + section components ──────────────────────────────────────────

function SectionGap() {
  return <text> </text>;
}

function Separator() {
  return <text fg="#374151">{'─'.repeat(36)}</text>;
}

function Header() {
  return (
    <box flexDirection="column">
      <text fg="#06b6d4">╭──────────────────────────────────╮</text>
      <text>
        <span fg="#06b6d4">│ </span>
        <span fg="#f3f4f6">agentx ops dashboard</span>
        <span fg="#06b6d4"> │</span>
      </text>
      <text fg="#06b6d4">╰──────────────────────────────────╯</text>
    </box>
  );
}

function AuthSection({ auth }: { auth: AuthInfo }) {
  return (
    <box flexDirection="column">
      <text fg="#f3f4f6">Authentication</text>
      {auth.authenticated ? (
        <>
          <text>
            <span fg="#4ade80"> ✓ </span>
            <span>github-copilot</span>
            {auth.username ? <span fg="#f3f4f6"> @{auth.username}</span> : null}
          </text>
          {auth.copilotSessionExpiresIn !== undefined && auth.copilotSessionExpiresIn > 0 ? (
            <text fg="#6b7280">
              {`  copilot session: ${Math.round(auth.copilotSessionExpiresIn / 60)}m left`}
            </text>
          ) : null}
        </>
      ) : (
        <>
          <text>
            <span fg="#f87171"> ✗ </span>
            <span>not authenticated</span>
          </text>
          <text fg="#6b7280"> press [l] to log in via GitHub</text>
        </>
      )}
    </box>
  );
}

function PeerServersSection({ trio }: { trio: TrioState }) {
  const dot = (ok: boolean) => (ok ? <span fg="#4ade80">●</span> : <span fg="#f87171">○</span>);
  return (
    <box flexDirection="column">
      <text fg="#f3f4f6">Peer servers (sockets)</text>
      <text>
        <span> </span>
        {dot(trio.harness)}
        <span> harness-server</span>
      </text>
      <text>
        <span> </span>
        {dot(trio.memory)}
        <span> edge-memory-server</span>
      </text>
      <text>
        <span> </span>
        {dot(trio.context)}
        <span> edge-context-server</span>
      </text>
    </box>
  );
}

function ActiveProductSection({ productId }: { productId: string }) {
  const unset = productId === '(unset)';
  return (
    <box flexDirection="column">
      <text fg="#f3f4f6">Active product</text>
      <text>
        <span> </span>
        <span fg={unset ? '#f87171' : '#e5e7eb'}>{productId}</span>
      </text>
    </box>
  );
}

function PipelinesSummary({ pipelines }: { pipelines: PipelineConfig[] }) {
  return (
    <box flexDirection="column">
      <text>
        <span fg="#f3f4f6">Pipelines</span>
        <span fg="#9ca3af"> ({pipelines.length} registered)</span>
      </text>
      {pipelines.slice(0, 6).map((p) => {
        const phaseCount = (p.phases ?? []).length;
        const phaseList = (p.phases ?? []).map((ph) => ph.id).join('→');
        return (
          <text key={p.id}>
            <span fg="#6b7280"> - </span>
            <span fg="#e5e7eb">{p.id.padEnd(28)}</span>
            <span fg="#6b7280">
              {' '}
              {phaseCount} phases {phaseList}
            </span>
          </text>
        );
      })}
    </box>
  );
}

function RecentJobsSection({ items }: { items: string[] }) {
  return (
    <box flexDirection="column">
      <text fg="#f3f4f6">Recent submissions</text>
      {items.map((j, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static recent-submissions list — index stable
        <text key={i} fg="#6b7280">
          {' '}
          · {j}
        </text>
      ))}
    </box>
  );
}

// ─── prompt area: switches by mode ────────────────────────────────────────

function PromptArea({
  mode,
  auth,
  jobs,
  pipelines,
  productList,
  selectedJob,
  selectedPipeline,
  pendingPipelineId,
  inputBuffer,
  inputError,
}: {
  mode: Mode;
  auth: AuthInfo;
  jobs: JobSummary[];
  pipelines: PipelineConfig[];
  productList: string[];
  recentJobs: string[];
  selectedJob: JobSummary | null;
  selectedPipeline: PipelineConfig | null;
  pendingPipelineId: string | null;
  inputBuffer: string;
  inputError: string | null;
}) {
  if (mode === 'menu') {
    return (
      <box flexDirection="column">
        <text fg="#9ca3af">commands:</text>
        {!auth.authenticated ? (
          <text>
            <span fg="#f3f4f6"> l</span>
            <span> login via GitHub</span>
          </text>
        ) : (
          <>
            <text>
              <span fg="#f3f4f6"> s</span>
              <span> submit an intent</span>
            </text>
            <text>
              <span fg="#f3f4f6"> p</span>
              <span> pick a product</span>
            </text>
          </>
        )}
        <text>
          <span fg="#f3f4f6"> j</span>
          <span> active jobs ({jobs.length})</span>
        </text>
        <text>
          <span fg="#f3f4f6"> L</span>
          <span> pipelines ({pipelines.length})</span>
        </text>
        <text>
          <span fg="#f3f4f6"> r</span>
          <span> refresh </span>
          <span fg="#f3f4f6">q</span>
          <span> quit</span>
        </text>
      </box>
    );
  }

  if (mode === 'awaitingPipelinePick') {
    return (
      <box flexDirection="column">
        <text fg="#9ca3af">pick a pipeline (Enter to confirm, Esc cancels):</text>
        {pipelines.map((p, i) => {
          const phaseList = (p.phases ?? []).map((ph) => ph.id).join('→');
          return (
            <text key={p.id}>
              <span fg="#f3f4f6"> {i + 1}.</span>
              <span> {p.id.padEnd(28)}</span>
              <span fg="#6b7280"> {phaseList}</span>
            </text>
          );
        })}
        {inputError ? <text fg="#f87171"> {inputError}</text> : null}
        <text>
          <span fg="#06b6d4"> &gt; </span>
          <span fg="#f3f4f6">{inputBuffer}</span>
          <span fg="#06b6d4">▌</span>
        </text>
      </box>
    );
  }

  if (mode === 'awaitingIntent') {
    const pipelineLine = pendingPipelineId ? ` (pipeline: ${pendingPipelineId})` : '';
    return (
      <box flexDirection="column">
        <text fg="#9ca3af">type your intent and press Enter{pipelineLine} — Esc cancels:</text>
        <text>
          <span fg="#06b6d4"> &gt; </span>
          <span fg="#f3f4f6">{inputBuffer}</span>
          <span fg="#06b6d4">▌</span>
        </text>
      </box>
    );
  }

  if (mode === 'awaitingProductPick') {
    return (
      <box flexDirection="column">
        <text fg="#9ca3af">pick a product (Enter to confirm, Esc cancels):</text>
        {productList.map((id, i) => (
          <text key={id}>
            <span fg="#f3f4f6"> {i + 1}.</span>
            <span> {id}</span>
          </text>
        ))}
        {inputError ? <text fg="#f87171"> {inputError}</text> : null}
        <text>
          <span fg="#06b6d4"> &gt; </span>
          <span fg="#f3f4f6">{inputBuffer}</span>
          <span fg="#06b6d4">▌</span>
        </text>
      </box>
    );
  }

  if (mode === 'awaitingLoginReturn') {
    return <text fg="#9ca3af">login subprocess returned — press Enter to refresh</text>;
  }

  if (mode === 'jobs') {
    return (
      <box flexDirection="column">
        <text>
          <span fg="#f3f4f6">Active jobs</span>
          <span fg="#9ca3af"> ({jobs.length})</span>
        </text>
        {jobs.length === 0 ? (
          <text fg="#6b7280"> none yet — back [b] then submit with [s]</text>
        ) : (
          jobs.slice(0, 9).map((j, i) => {
            const num = `${i + 1}`.padStart(2);
            const name = (j.name ?? '(unnamed)').padEnd(22).slice(0, 22);
            const product = (j.productId ?? '?').padEnd(16).slice(0, 16);
            return (
              <text key={j.jobId}>
                <span fg="#f3f4f6"> {num}.</span>
                <span fg="#6b7280"> {j.jobId}</span>
                <span>
                  {' '}
                  {name} {product}{' '}
                </span>
                <span fg={statusFg(j.status)}>{j.status ?? '?'}</span>
              </text>
            );
          })
        )}
        <text fg="#9ca3af">commands:</text>
        <text>
          <span fg="#f3f4f6"> &lt;1-9&gt;</span>
          <span> drill </span>
          <span fg="#f3f4f6">r</span>
          <span> refresh </span>
          <span fg="#f3f4f6">b</span>
          <span> back </span>
          <span fg="#f3f4f6">q</span>
          <span> quit</span>
        </text>
      </box>
    );
  }

  if (mode === 'jobDetail') {
    if (!selectedJob) {
      return <text fg="#f87171">(job detail not loaded)</text>;
    }
    return (
      <box flexDirection="column">
        <text>
          <span fg="#f3f4f6">Job</span>
          <span> {selectedJob.jobId}</span>
        </text>
        <KvLine k="name" v={selectedJob.name ?? '(unnamed)'} />
        <text>
          <span fg="#6b7280"> status: </span>
          <span fg={statusFg(selectedJob.status)}>{selectedJob.status ?? '?'}</span>
        </text>
        <KvLine k="pipeline" v={selectedJob.pipeline ?? '?'} />
        <KvLine k="productId" v={selectedJob.productId ?? '?'} />
        {selectedJob.productRepos?.length ? (
          <KvLine k="repos" v={selectedJob.productRepos.join(', ')} />
        ) : null}
        {selectedJob.submittedAt ? <KvLine k="submittedAt" v={selectedJob.submittedAt} /> : null}
        {selectedJob.input ? <KvLine k="input" v={trunc(selectedJob.input, 60)} /> : null}
        <text fg="#9ca3af">commands:</text>
        <text>
          <span fg="#f3f4f6"> r</span>
          <span> refresh </span>
          <span fg="#f3f4f6">b</span>
          <span> back </span>
          <span fg="#f3f4f6">d</span>
          <span> dashboard </span>
          <span fg="#f3f4f6">q</span>
          <span> quit</span>
        </text>
      </box>
    );
  }

  if (mode === 'pipelines') {
    return (
      <box flexDirection="column">
        <text>
          <span fg="#f3f4f6">Pipelines</span>
          <span fg="#9ca3af"> ({pipelines.length} registered)</span>
        </text>
        {pipelines.length === 0 ? (
          <text fg="#6b7280"> none — add .harness/config/pipelines.json</text>
        ) : (
          pipelines.slice(0, 9).map((p, i) => {
            const num = `${i + 1}`.padStart(2);
            const phaseCount = (p.phases ?? []).length;
            const agents = uniqueAgents(p);
            return (
              <box key={p.id} flexDirection="column">
                <text>
                  <span fg="#f3f4f6"> {num}.</span>
                  <span> {p.id.padEnd(30)}</span>
                  <span fg="#6b7280">
                    {' '}
                    {phaseCount} phases {agents.join(', ')}
                  </span>
                </text>
                {p.description ? <text fg="#6b7280"> {p.description}</text> : null}
              </box>
            );
          })
        )}
        <text fg="#9ca3af">commands:</text>
        <text>
          <span fg="#f3f4f6"> &lt;1-9&gt;</span>
          <span> drill </span>
          <span fg="#f3f4f6">b</span>
          <span> back </span>
          <span fg="#f3f4f6">q</span>
          <span> quit</span>
        </text>
      </box>
    );
  }

  if (mode === 'pipelineDetail') {
    const p = selectedPipeline;
    if (!p) {
      return <text fg="#f87171">(no pipeline selected)</text>;
    }
    return (
      <box flexDirection="column">
        <text>
          <span fg="#f3f4f6">Pipeline</span>
          <span> {p.id}</span>
        </text>
        {p.name ? <KvLine k="name" v={p.name} /> : null}
        {p.description ? <KvLine k="description" v={p.description} /> : null}
        <text fg="#f3f4f6"> phases ({(p.phases ?? []).length})</text>
        {(p.phases ?? []).map((ph, i) => (
          <box key={ph.id} flexDirection="column">
            <text>
              <span fg="#9ca3af"> {i + 1}. </span>
              <span fg="#f3f4f6">{ph.id.padEnd(14)}</span>
              <span fg="#06b6d4"> {ph.agent ?? '(no agent)'}</span>
              {ph.model ? <span fg="#6b7280"> {ph.model}</span> : null}
              {ph.reasoningEffort ? (
                <span fg="#6b7280"> reasoning={ph.reasoningEffort}</span>
              ) : null}
            </text>
            {ph.description ? <text fg="#6b7280"> {ph.description}</text> : null}
            {ph.tools?.length ? <text fg="#6b7280"> tools: {ph.tools.join(', ')}</text> : null}
          </box>
        ))}
        <text fg="#9ca3af">commands:</text>
        <text>
          <span fg="#f3f4f6"> b</span>
          <span> back to pipelines </span>
          <span fg="#f3f4f6">d</span>
          <span> dashboard </span>
          <span fg="#f3f4f6">q</span>
          <span> quit</span>
        </text>
      </box>
    );
  }

  // Should be unreachable
  return <text fg="#f87171">(unknown mode)</text>;
}

function KvLine({ k, v }: { k: string; v: string }) {
  return (
    <text>
      <span fg="#6b7280"> {`${k}:`.padEnd(13)}</span>
      <span fg="#e5e7eb">{v}</span>
    </text>
  );
}

// ─── bootstrap ────────────────────────────────────────────────────────────

const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<App />);

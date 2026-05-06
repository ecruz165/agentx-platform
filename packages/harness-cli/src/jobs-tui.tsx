/** @jsxImportSource @opentui/react */
import { useEffect, useRef, useState } from 'react';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createCliRenderer } from '@opentui/core';
import { createRoot, useKeyboard, useOnResize, useRenderer } from '@opentui/react';
import type { AgentTokens, Envelope, RegisteredAgent } from '@agentx/harness-core';
import { formatTokens, formatTokenHistory } from './token-format.ts';
import { eventPreview } from './event-preview.ts';
import { connectSseStream } from './sse-client.ts';
import { udsRequest } from './uds-client.ts';

/**
 * Three-column jobs viewer (OpenTUI port of the original ANSI/readline TUI).
 *
 *   ┌─ Jobs ──────────┬─ Agents ─────────────┬─ Events · <jobId> ─────┐
 *   │ ▸ #abc passkey  │ planner    ● running │ planner request: …      │
 *   │   #def spring   │ implementer○ pending │ planner response: …     │
 *   │   #ghi mtauth ✓ │                      │ (live SSE stream)       │
 *   ├─────────────────┼──────────────────────┼─────────────────────────┤
 *   │ N active        │ M agents             │ ● live · 12 events      │
 *   └─────────────────┴──────────────────────┴─────────────────────────┘
 *     j/k or ↑↓ nav   enter drill   r refresh   m main   q quit
 *
 * Polls /v1/jobs every 3s; SSE-subscribes to the selected job's events.
 * On selection change, the SSE stream is re-attached and the buffer reset.
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
const EVENT_BUFFER_CAP = 200;

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
  tokens?: AgentTokens;
}

// ─── UDS helpers ──────────────────────────────────────────────────────────

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

// ─── pure helpers ─────────────────────────────────────────────────────────

function trunc(s: string, w: number): string {
  return s.length <= w ? s : s.slice(0, Math.max(0, w - 1)) + '…';
}

function statusFg(s?: string): string {
  if (s === 'received' || s === 'completed') return '#4ade80'; // green
  if (s === 'failed' || s === 'errored') return '#f87171';     // red
  if (s === 'cancelled' || s === 'rejected') return '#facc15'; // yellow
  if (s === 'running') return '#06b6d4';                        // cyan
  return '#9ca3af';                                             // gray
}

function agentDot(status: string): { dot: string; fg: string } {
  if (status === 'completed') return { dot: '●', fg: '#4ade80' };
  if (status === 'failed') return { dot: '●', fg: '#f87171' };
  if (status === 'running') return { dot: '●', fg: '#06b6d4' };
  return { dot: '○', fg: '#6b7280' };
}

function formatTs(ts: string): string {
  const m = ts.match(/T(\d\d:\d\d:\d\d)/);
  return m ? m[1]! : ts.slice(0, 8);
}

function eventKindFg(kind: Envelope['event']['kind']): string {
  if (kind === 'error') return '#f87171';
  if (kind === 'response') return '#4ade80';
  if (kind === 'loader-event') return '#a78bfa'; // purple — distinguishes loader streams from agent streams
  return '#06b6d4';
}

function shortJobId(id: string): string {
  return id.startsWith('job_') ? '#' + id.slice(4, 11) : id.slice(0, 8);
}

// ─── React app ────────────────────────────────────────────────────────────

/**
 * Workaround for OpenTUI 0.2.2: useTerminalDimensions can return {0, 0} on
 * first render before the renderer's resize event fires. This hook falls back
 * to process.stdout.columns/rows when the renderer reports 0, and re-reads
 * renderer dims in a mount-effect plus subscribes to resize events.
 */
function useDims(): { width: number; height: number } {
  const renderer = useRenderer();
  const measure = (): { width: number; height: number } => ({
    width: renderer.width || process.stdout.columns || 80,
    height: renderer.height || process.stdout.rows || 24,
  });
  const [dims, setDims] = useState(measure);
  useEffect(() => {
    setDims(measure());
  }, [renderer]);
  useOnResize((w, h) => {
    setDims({
      width: w || process.stdout.columns || 80,
      height: h || process.stdout.rows || 24,
    });
  });
  return dims;
}

function App() {
  const dims = useDims();
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedDetail, setSelectedDetail] = useState<JobSummary | null>(null);
  const [events, setEvents] = useState<Envelope[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const sseUnsubRef = useRef<(() => void) | null>(null);
  const pollTickRef = useRef(0);

  // ── Polling: refresh jobs list every POLL_MS, plus on manual r ────────
  async function loadJobs(): Promise<void> {
    if (!existsSync(HARNESS_SOCKET)) {
      setJobs([]);
      setSelectedDetail(null);
      detachSse();
      setError('harness-server is down — start it with pnpm tmux');
      setLoading(false);
      return;
    }
    try {
      const next = await fetchJobs();
      setJobs(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadJobs();
    const id = setInterval(() => {
      pollTickRef.current++;
      void loadJobs();
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  // ── Re-fetch detail + attach SSE when selection or jobs list changes ──
  useEffect(() => {
    if (jobs.length === 0) {
      setSelectedDetail(null);
      detachSse();
      return;
    }
    const safeIdx = Math.min(selectedIndex, jobs.length - 1);
    if (safeIdx !== selectedIndex) {
      setSelectedIndex(safeIdx);
      return; // re-runs with corrected index
    }
    const id = jobs[safeIdx]!.jobId;
    let cancelled = false;
    fetchDetail(id).then((detail) => {
      if (!cancelled) setSelectedDetail(detail);
    }).catch(() => {
      if (!cancelled) setSelectedDetail(null);
    });
    attachSse(id);
    return () => { cancelled = true; };
  }, [jobs, selectedIndex]);

  // ── SSE management (refs, not state — doesn't drive renders) ──────────
  function attachSse(jobId: string): void {
    detachSse();
    setEvents([]);
    setStreaming(true);
    sseUnsubRef.current = connectSseStream<Envelope>(
      HARNESS_SOCKET,
      `/v1/jobs/${jobId}/events`,
      (envelope) => {
        setEvents((prev) => {
          const next = [...prev, envelope];
          return next.length > EVENT_BUFFER_CAP
            ? next.slice(-EVENT_BUFFER_CAP)
            : next;
        });
      },
      (err) => {
        setError(`SSE: ${err.message}`);
        setStreaming(false);
      }
    );
  }

  function detachSse(): void {
    if (sseUnsubRef.current) {
      try { sseUnsubRef.current(); } catch { /* ignore */ }
      sseUnsubRef.current = null;
    }
    setStreaming(false);
  }

  // Cleanup SSE on unmount
  useEffect(() => () => { detachSse(); }, []);

  // ── Keyboard ─────────────────────────────────────────────────────────
  useKeyboard((e) => {
    if (e.name === 'q') {
      detachSse();
      process.exit(0);
    } else if (e.name === 'm') {
      // tmux: switch to main window without killing this process
      const child = spawn(
        'tmux',
        ['select-window', '-t', `${TMUX_SESSION}:dash`],
        { stdio: 'ignore' }
      );
      child.on('error', () => { /* tmux may not be installed; ignore */ });
    } else if (e.name === 'r' || e.name === 'return') {
      setLoading(true);
      void loadJobs();
    } else if (e.name === 'j' || e.name === 'down') {
      setSelectedIndex((i) => Math.min(i + 1, Math.max(0, jobs.length - 1)));
    } else if (e.name === 'k' || e.name === 'up') {
      setSelectedIndex((i) => Math.max(0, i - 1));
    }
  });

  // Until we have valid dims from the renderer, render nothing — first paint
  // happens on the next render after dims arrive.
  if (dims.width === 0 || dims.height === 0) return null;

  const leftW = Math.max(20, Math.floor(dims.width * 0.22));
  const midW = Math.max(28, Math.floor(dims.width * 0.30));

  return (
    <box flexDirection="column" width={dims.width} height={dims.height}>
      {/* Three-column body — fills vertical space between top and footer */}
      <box flexDirection="row" flexGrow={1} width={dims.width}>
        <JobsColumn width={leftW} jobs={jobs} selectedIndex={selectedIndex} />
        <AgentsColumn width={midW} job={selectedDetail} />
        <EventsColumn job={selectedDetail} events={events} />
      </box>

      {/* Footer summary — natural height */}
      <box flexDirection="row" paddingLeft={1} paddingRight={1} width={dims.width}>
        <box width={leftW}>
          <text fg="#9ca3af">{jobs.length} active</text>
        </box>
        <box width={midW}>
          <text fg="#9ca3af">
            {selectedDetail?.agents
              ? `${selectedDetail.agents.length} agents`
              : '—'}
          </text>
        </box>
        <box flexGrow={1}>
          <FooterStatus
            error={error}
            loading={loading}
            streaming={streaming}
            eventCount={events.length}
          />
        </box>
      </box>

      {/* Hint line */}
      <text fg="#6b7280"> j/k or ↑↓ nav   enter/r refresh   m main   q quit</text>
    </box>
  );
}

// ─── columns ──────────────────────────────────────────────────────────────

function JobsColumn({
  width,
  jobs,
  selectedIndex,
}: {
  width: number;
  jobs: JobSummary[];
  selectedIndex: number;
}) {
  return (
    <box
      width={width}
      flexShrink={0}
      border
      title="Jobs"
      flexDirection="column"
      padding={1}
    >
      {jobs.length === 0 ? (
        <text fg="#6b7280">(no jobs yet)</text>
      ) : (
        jobs.map((j, i) => {
          const selected = i === selectedIndex;
          const id = shortJobId(j.jobId);
          const name = trunc(j.name ?? '(unnamed)', 30);
          return (
            <text key={j.jobId}>
              <span fg={selected ? '#06b6d4' : '#6b7280'}>
                {selected ? '▸ ' : '  '}
              </span>
              <span fg="#6b7280">{id}</span>
              <span> </span>
              <span fg={selected ? '#f3f4f6' : '#9ca3af'}>{name}</span>
              {j.status === 'completed' ? <span fg="#4ade80"> ✓</span> : null}
            </text>
          );
        })
      )}
    </box>
  );
}

function AgentsColumn({ width, job }: { width: number; job: JobSummary | null }) {
  if (!job) {
    return (
      <box
        width={width}
        flexShrink={0}
        border
        title="Agents"
        flexDirection="column"
        padding={1}
      >
        <text fg="#6b7280">(no job selected)</text>
      </box>
    );
  }

  const agents = job.agents ?? [];
  // Inner width available for the per-interaction sub-row (subtract
  // the 2 chars of indent we render before token entries, plus
  // border + padding from the box itself). Border (2) + padding (2) =
  // 4 chars consumed by chrome. Sub-row indent is 2.
  const tokenRowWidth = Math.max(8, width - 4 - 2);

  return (
    <box
      width={width}
      flexShrink={0}
      border
      title="Agents"
      flexDirection="column"
      padding={1}
    >
      <text>
        <span fg="#9ca3af">pipeline: </span>
        <span fg="#f3f4f6">{trunc(job.pipeline ?? '?', 40)}</span>
      </text>
      <text>
        <span fg="#9ca3af">product:  </span>
        <span fg="#f3f4f6">{trunc(job.productId ?? '?', 40)}</span>
      </text>
      {job.tokens ? (
        <text>
          <span fg="#9ca3af">tokens:   </span>
          <span fg="#fbbf24">{formatTokens(job.tokens)}</span>
        </text>
      ) : null}
      <text> </text>
      {agents.length === 0 ? (
        <text fg="#6b7280">(no agents registered)</text>
      ) : (
        <>
          <text fg="#f3f4f6">agent             role        status</text>
          {agents.flatMap((a) => {
            const ad = agentDot(a.status);
            const rows = [
              <text key={a.id}>
                <span fg={ad.fg}>{ad.dot}</span>
                <span> </span>
                <span fg="#e5e7eb">{trunc(a.id, 16).padEnd(16)}</span>
                <span> </span>
                <span fg="#9ca3af">{trunc(a.role, 10).padEnd(10)}</span>
                <span> </span>
                <span fg={ad.fg}>{a.status}</span>
              </text>,
            ];
            // Slice 13d: per-interaction array on a sub-row when the
            // agent has emitted any usage. Rendered indented under the
            // agent so the eye groups them. Multi-call agents (slice
            // 13c fallback retries, future LangGraph multi-turn) show
            // one entry per call: ↑1.2k ↓340 ↑1.5k ↓220 +N
            const history = a.tokenHistory;
            if (history && history.length > 0) {
              rows.push(
                <text key={`${a.id}-tokens`}>
                  <span>  </span>
                  <span fg="#fbbf24">{formatTokenHistory(history, tokenRowWidth)}</span>
                </text>
              );
            }
            return rows;
          })}
        </>
      )}
    </box>
  );
}

function EventsColumn({
  job,
  events,
}: {
  job: JobSummary | null;
  events: Envelope[];
}) {
  if (!job) {
    return (
      <box flexGrow={1} border title="Events" flexDirection="column" padding={1}>
        <text fg="#6b7280">(no job selected)</text>
      </box>
    );
  }

  return (
    <box
      flexGrow={1}
      border
      title={`Events · ${job.jobId}`}
      flexDirection="column"
      padding={1}
    >
      <text>
        <span fg="#9ca3af">jobId:      </span>
        <span fg="#e5e7eb">{job.jobId}</span>
      </text>
      <text>
        <span fg="#9ca3af">status:     </span>
        <span fg={statusFg(job.status)}>{job.status ?? '?'}</span>
      </text>
      <text>
        <span fg="#9ca3af">submitted:  </span>
        <span fg="#e5e7eb">{job.submittedAt ?? '?'}</span>
      </text>
      <text> </text>
      <text>
        <span fg="#f3f4f6">live events</span>
        <span fg="#9ca3af"> ({events.length})</span>
      </text>
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        {events.length === 0 ? (
          <text fg="#6b7280">(awaiting events…)</text>
        ) : (
          events.map((env, i) => (
            <text key={i}>
              <span fg="#6b7280">{formatTs(env.event.ts)}</span>
              <span> </span>
              <span fg="#9ca3af">{trunc(env.agentId, 12).padEnd(12)}</span>
              <span> </span>
              <span fg={eventKindFg(env.event.kind)}>
                {env.event.kind.padEnd(8)}
              </span>
              <span> </span>
              <span fg="#e5e7eb">{eventPreview(env)}</span>
            </text>
          ))
        )}
      </scrollbox>
    </box>
  );
}

function FooterStatus({
  error,
  loading,
  streaming,
  eventCount,
}: {
  error: string | null;
  loading: boolean;
  streaming: boolean;
  eventCount: number;
}) {
  if (error) {
    return <text fg="#f87171">{error}</text>;
  }
  if (loading) {
    return <text fg="#facc15">loading…</text>;
  }
  if (streaming) {
    return (
      <text>
        <span fg="#4ade80">● live</span>
        <span fg="#6b7280">  {eventCount} events buffered</span>
      </text>
    );
  }
  return <text fg="#6b7280">— no stream</text>;
}

// ─── bootstrap ────────────────────────────────────────────────────────────
const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<App />);

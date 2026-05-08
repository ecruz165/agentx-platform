/**
 * `workspace bench` — eval-harness CLI.
 *
 * Two flows:
 *   workspace bench upsert <suiteId> --inputs <file.jsonl> [--name <name>]
 *     Reads JSONL → wraps as a JSON array → POST /api/evals/suites
 *   workspace bench run <suiteId> --flow <flowId> --product <productId> --label <label>
 *     POST /api/evals/suites/{id}/run → prints runId
 *   workspace bench compare <runId>[,<runId>...]
 *     GET /api/benchmarks/compare → prints side-by-side aggregates
 *
 * The CLI is a thin wrapper. All of the behavior lives behind the
 * controlplane HTTP API; this just packages the curl-equivalent
 * commands into ergonomic flags.
 */

import { readFileSync } from 'node:fs';

interface BenchOptions {
  /** Override the controlplane base URL (default http://localhost:8080). */
  url?: string;
  /** Tenant id sent in X-Org-Id (default dev-org). */
  org?: string;
}

const DEFAULT_URL = 'http://localhost:8080';
const DEFAULT_ORG = 'dev-org';

function makeFetcher(opts: BenchOptions) {
  const base = (opts.url ?? DEFAULT_URL).replace(/\/+$/, '');
  const org = opts.org ?? DEFAULT_ORG;
  return async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Org-Id': org,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  };
}

// ── upsert: file.jsonl → POST /api/evals/suites ──────────────────────

interface UpsertBenchOptions extends BenchOptions {
  inputs: string;
  name?: string;
  description?: string;
}

export async function runBenchUpsert(suiteId: string, opts: UpsertBenchOptions): Promise<void> {
  if (!suiteId) {
    console.error('error: suiteId is required');
    process.exit(2);
  }
  if (!opts.inputs) {
    console.error('error: --inputs <file.jsonl> is required');
    process.exit(2);
  }

  const lines = readFileSync(opts.inputs, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const inputs: unknown[] = [];
  for (const line of lines) {
    try {
      inputs.push(JSON.parse(line));
    } catch (err) {
      console.error(`error: failed to parse JSONL line: ${line.slice(0, 100)}`);
      process.exit(2);
    }
  }

  const fetcher = makeFetcher(opts);
  const result = await fetcher<{ id: string }>('POST', '/api/evals/suites', {
    id: suiteId,
    name: opts.name ?? suiteId,
    description: opts.description,
    inputs,
  });

  console.log(`[bench] upserted suite ${result.id} with ${inputs.length} input(s)`);
}

// ── run: POST /api/evals/suites/{id}/run ─────────────────────────────

interface RunBenchOptions extends BenchOptions {
  flow: string;
  product: string;
  label?: string;
  config?: string;       // JSON string of extra config to merge
}

export async function runBenchRun(suiteId: string, opts: RunBenchOptions): Promise<void> {
  if (!suiteId) {
    console.error('error: suiteId is required');
    process.exit(2);
  }
  if (!opts.flow || !opts.product) {
    console.error('error: --flow and --product are required');
    process.exit(2);
  }

  let config: unknown = undefined;
  if (opts.config) {
    try {
      config = JSON.parse(opts.config);
    } catch {
      console.error('error: --config must be a valid JSON string');
      process.exit(2);
    }
  }

  const fetcher = makeFetcher(opts);
  const result = await fetcher<{ runId: string; label?: string; jobIds: string[] }>(
    'POST',
    `/api/evals/suites/${encodeURIComponent(suiteId)}/run`,
    {
      flowId: opts.flow,
      productId: opts.product,
      label: opts.label,
      config,
    },
  );

  console.log(`[bench] runId=${result.runId}${opts.label ? ` (${opts.label})` : ''}`);
  console.log(`[bench] submitted ${result.jobIds.length} job(s):`);
  for (const id of result.jobIds) console.log(`  ${id}`);
  console.log('');
  console.log(`[bench] watch with: workspace bench compare ${result.runId}`);
}

// ── score: rubric-mode local scorer → POST /api/jobs/{id}/score ─────

interface ScoreBenchOptions extends BenchOptions {
  judge?: string;
  waitSeconds?: string;
}

interface JobRecord {
  id: string;
  status: string;
  output?: unknown;
  input?: unknown;
}

/**
 * Walk the jobs in a benchmark run, evaluate each against the input's
 * `expected` rubric block, POST a score per job. v1 rubric supports:
 *
 *   expected.includes  — array of substrings; ALL must appear in
 *                        output (or output.text / output.body)
 *   expected.equals    — JSON deep-equal against output
 *   expected.regex     — single regex pattern; output must match
 *
 * Inputs without an `expected` block score 0 with a "no-rubric"
 * rationale so the cohort's avgScore reflects rubric coverage.
 */
export async function runBenchScore(runId: string, opts: ScoreBenchOptions): Promise<void> {
  if (!runId) {
    console.error('error: runId is required');
    process.exit(2);
  }
  const fetcher = makeFetcher(opts);
  const judge = opts.judge ?? 'rubric';

  const waitSec = opts.waitSeconds ? Number(opts.waitSeconds) : 0;
  if (waitSec > 0) {
    console.log(`[bench] waiting up to ${waitSec}s for jobs to terminate…`);
    const deadline = Date.now() + waitSec * 1000;
    while (Date.now() < deadline) {
      const list = await fetcher<JobRecord[]>(
        'GET',
        `/api/jobs?benchmarkRunId=${encodeURIComponent(runId)}&limit=500`,
      );
      const inFlight = list.filter((j) => isInFlight(j.status)).length;
      if (inFlight === 0) break;
      await sleep(2000);
    }
  }

  const jobs = await fetcher<JobRecord[]>(
    'GET',
    `/api/jobs?benchmarkRunId=${encodeURIComponent(runId)}&limit=500`,
  );
  if (jobs.length === 0) {
    console.log(`[bench] no jobs in ${runId}`);
    return;
  }

  let scored = 0;
  let zero = 0;
  for (const job of jobs) {
    const { score, rationale } = scoreJob(job);
    await fetcher('POST', `/api/jobs/${encodeURIComponent(job.id)}/score`, {
      score,
      rationale,
      judge,
    });
    scored += 1;
    if (score === 0) zero += 1;
    console.log(`  ${job.id.slice(0, 16)}…  ${score.toFixed(2)}  ${rationale}`);
  }
  console.log(`[bench] scored ${scored} job(s) (${scored - zero} passed, ${zero} zero)`);
}

function scoreJob(job: JobRecord): { score: number; rationale: string } {
  const input = (job.input ?? {}) as Record<string, unknown>;
  const expected = input?.expected as Record<string, unknown> | undefined;
  if (!expected) return { score: 0, rationale: 'no-rubric (input.expected missing)' };
  const output = job.output;
  const outputStr = textOf(output);

  if (Array.isArray(expected.includes)) {
    const missing = (expected.includes as string[]).filter((s) => !outputStr.includes(s));
    if (missing.length > 0) {
      return { score: 0, rationale: `missing substrings: ${missing.join(', ').slice(0, 100)}` };
    }
  }
  if (typeof expected.regex === 'string') {
    const re = new RegExp(expected.regex);
    if (!re.test(outputStr)) {
      return { score: 0, rationale: `regex did not match: ${expected.regex}` };
    }
  }
  if (expected.equals !== undefined) {
    if (!deepEqual(expected.equals, output)) {
      return { score: 0, rationale: 'equals check failed' };
    }
  }
  return { score: 1, rationale: 'rubric pass' };
}

function textOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.body === 'string') return o.body;
    return JSON.stringify(v);
  }
  return String(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (!deepEqual((a as Record<string, unknown>)[ka[i]!], (b as Record<string, unknown>)[kb[i]!])) {
      return false;
    }
  }
  return true;
}

function isInFlight(status: string): boolean {
  return status === 'queued' || status === 'running' || status === 'cancelling';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── compare: GET /api/benchmarks/compare ────────────────────────────

interface CompareBenchOptions extends BenchOptions {}

interface SummaryRow {
  runId: string;
  label?: string;
  total: number;
  completed: number;
  failed: number;
  inFlight: number;
  cancelled: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  successRate: number;
  scored: number;
  avgScore?: number | null;
  p50Score?: number | null;
}

export async function runBenchCompare(runIdsCsv: string, opts: CompareBenchOptions): Promise<void> {
  if (!runIdsCsv) {
    console.error('error: at least one runId is required');
    process.exit(2);
  }
  const fetcher = makeFetcher(opts);
  const runIdParam = runIdsCsv.split(',').map((s) => s.trim()).filter(Boolean).join(',');
  const rows = await fetcher<SummaryRow[]>(
    'GET',
    `/api/benchmarks/compare?runIds=${encodeURIComponent(runIdParam)}`,
  );

  // Tab-formatted table — short enough to scan, no extra deps.
  const cols = [
    'runId', 'label', 'total', 'completed', 'failed', 'inFlight',
    'p50ms', 'p95ms', 'success', 'scored', 'avgScore',
  ];
  console.log(cols.join('\t'));
  for (const r of rows) {
    console.log([
      r.runId,
      r.label ?? '',
      r.total,
      r.completed,
      r.failed,
      r.inFlight,
      r.p50LatencyMs,
      r.p95LatencyMs,
      `${(r.successRate * 100).toFixed(1)}%`,
      r.scored,
      r.avgScore != null ? r.avgScore.toFixed(3) : '—',
    ].join('\t'));
  }
}

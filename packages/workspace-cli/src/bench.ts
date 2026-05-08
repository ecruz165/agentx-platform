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
    'runId', 'label', 'total', 'completed', 'failed', 'inFlight', 'p50ms', 'p95ms', 'success',
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
    ].join('\t'));
  }
}

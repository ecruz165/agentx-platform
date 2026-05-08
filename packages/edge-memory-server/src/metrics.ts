/**
 * Prometheus metrics collector — PRD F13. Hand-rolled (no `prom-client`
 * dependency) because the surface is small and we want zero-cost
 * cold-start: a daemon shouldn't pay 1MB+ of import resolution for
 * a `/metrics` endpoint that's polled every 15s.
 *
 * Exposed:
 *   edge_memory_requests_total{op}      counter — completed requests
 *   edge_memory_errors_total{op}        counter — 4xx/5xx responses
 *   edge_memory_request_duration_seconds{op}  histogram — latency
 *   edge_memory_entries_total           gauge — last-known store size
 *   edge_memory_idle_state              gauge — 1 if idle, 0 if warm
 *
 * `op` is a bounded set (see MetricOp) — no client-controlled label
 * cardinality.
 */

const BUCKETS_SECONDS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

export type MetricOp =
  | 'put'
  | 'query'
  | 'forget'
  | 'export'
  | 'import'
  | 'audit'
  | 'tag'
  | 'consolidate'
  | 'snapshot'
  | 'restore'
  | 'inspect'
  | 'cleanup'
  | 'health'
  | 'metrics'
  | 'other';

interface HistogramState {
  counts: number[];
  sum: number;
  total: number;
}

export class Metrics {
  private readonly requests = new Map<MetricOp, number>();
  private readonly errors = new Map<MetricOp, number>();
  private readonly histograms = new Map<MetricOp, HistogramState>();
  private entries = 0;
  private idle = false;

  incRequest(op: MetricOp): void {
    this.requests.set(op, (this.requests.get(op) ?? 0) + 1);
  }

  incError(op: MetricOp): void {
    this.errors.set(op, (this.errors.get(op) ?? 0) + 1);
  }

  observeLatency(op: MetricOp, seconds: number): void {
    let h = this.histograms.get(op);
    if (!h) {
      h = { counts: new Array(BUCKETS_SECONDS.length).fill(0), sum: 0, total: 0 };
      this.histograms.set(op, h);
    }
    h.sum += seconds;
    h.total++;
    for (let i = 0; i < BUCKETS_SECONDS.length; i++) {
      if (seconds <= BUCKETS_SECONDS[i]!) h.counts[i]!++;
    }
  }

  setEntries(n: number): void {
    this.entries = n;
  }

  setIdle(idle: boolean): void {
    this.idle = idle;
  }

  /** Render in Prometheus exposition format. */
  render(): string {
    const lines: string[] = [];

    lines.push(
      '# HELP edge_memory_requests_total Completed requests by op.',
      '# TYPE edge_memory_requests_total counter',
    );
    for (const [op, n] of this.requests) {
      lines.push(`edge_memory_requests_total{op="${op}"} ${n}`);
    }

    lines.push(
      '# HELP edge_memory_errors_total 4xx/5xx responses by op.',
      '# TYPE edge_memory_errors_total counter',
    );
    for (const [op, n] of this.errors) {
      lines.push(`edge_memory_errors_total{op="${op}"} ${n}`);
    }

    lines.push(
      '# HELP edge_memory_request_duration_seconds Request latency by op.',
      '# TYPE edge_memory_request_duration_seconds histogram',
    );
    for (const [op, h] of this.histograms) {
      for (let i = 0; i < BUCKETS_SECONDS.length; i++) {
        lines.push(
          `edge_memory_request_duration_seconds_bucket{op="${op}",le="${BUCKETS_SECONDS[i]}"} ${h.counts[i]}`,
        );
      }
      lines.push(
        `edge_memory_request_duration_seconds_bucket{op="${op}",le="+Inf"} ${h.total}`,
        `edge_memory_request_duration_seconds_sum{op="${op}"} ${h.sum}`,
        `edge_memory_request_duration_seconds_count{op="${op}"} ${h.total}`,
      );
    }

    lines.push(
      '# HELP edge_memory_entries_total Last-known entry count from /health.',
      '# TYPE edge_memory_entries_total gauge',
      `edge_memory_entries_total ${this.entries}`,
    );

    lines.push(
      '# HELP edge_memory_idle_state 1 if idle (cold), 0 if warm. PRD F9.',
      '# TYPE edge_memory_idle_state gauge',
      `edge_memory_idle_state ${this.idle ? 1 : 0}`,
    );

    return `${lines.join('\n')}\n`;
  }
}

/** Map a URL path to a bounded `op` label. Unknown paths get 'other'
 *  so client-controlled cardinality can't leak into label space. */
export function opForPath(path: string): MetricOp {
  if (path === '/health') return 'health';
  if (path === '/metrics') return 'metrics';
  if (path === '/v1/audit') return 'audit';
  if (!path.startsWith('/v1/memory/')) return 'other';
  const tail = path.slice('/v1/memory/'.length);
  switch (tail) {
    case 'put':
      return 'put';
    case 'query':
      return 'query';
    case 'forget':
      return 'forget';
    case 'export':
      return 'export';
    case 'import':
      return 'import';
    case 'tag':
      return 'tag';
    case 'consolidate':
      return 'consolidate';
    case 'snapshot':
      return 'snapshot';
    case 'restore':
      return 'restore';
    case 'inspect':
      return 'inspect';
    case 'cleanup-unconfirmed':
      return 'cleanup';
    default:
      return 'other';
  }
}

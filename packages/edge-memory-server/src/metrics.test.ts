/**
 * Unit tests for the in-process Prometheus metrics collector.
 * Server-level integration (does /metrics surface counters?) lives in
 * server.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { Metrics, opForPath } from './metrics.ts';

describe('Metrics — counters', () => {
  it('starts empty; counters appear once incremented', () => {
    const m = new Metrics();
    expect(m.render()).not.toContain('edge_memory_requests_total{op=');
    m.incRequest('put');
    expect(m.render()).toContain('edge_memory_requests_total{op="put"} 1');
  });

  it('increments per op independently', () => {
    const m = new Metrics();
    m.incRequest('put');
    m.incRequest('put');
    m.incRequest('query');
    const out = m.render();
    expect(out).toContain('edge_memory_requests_total{op="put"} 2');
    expect(out).toContain('edge_memory_requests_total{op="query"} 1');
  });

  it('errors counter is independent of requests counter', () => {
    const m = new Metrics();
    m.incRequest('forget');
    m.incError('forget');
    m.incError('forget');
    const out = m.render();
    expect(out).toContain('edge_memory_requests_total{op="forget"} 1');
    expect(out).toContain('edge_memory_errors_total{op="forget"} 2');
  });
});

describe('Metrics — histograms', () => {
  it('emits bucket counts cumulatively per Prometheus convention', () => {
    const m = new Metrics();
    m.observeLatency('put', 0.0008); // <= 0.001
    m.observeLatency('put', 0.005); // <= 0.005
    m.observeLatency('put', 0.5); // <= 0.5
    const out = m.render();
    expect(out).toContain('edge_memory_request_duration_seconds_bucket{op="put",le="0.001"} 1');
    expect(out).toContain('edge_memory_request_duration_seconds_bucket{op="put",le="0.005"} 2');
    expect(out).toContain('edge_memory_request_duration_seconds_bucket{op="put",le="0.5"} 3');
    expect(out).toContain('edge_memory_request_duration_seconds_bucket{op="put",le="+Inf"} 3');
    expect(out).toContain('edge_memory_request_duration_seconds_count{op="put"} 3');
    // Sum: 0.0008 + 0.005 + 0.5 = 0.5058
    expect(out).toMatch(/edge_memory_request_duration_seconds_sum\{op="put"\} 0\.5058/);
  });

  it('includes +Inf bucket for observations beyond the largest finite bucket', () => {
    const m = new Metrics();
    m.observeLatency('query', 30); // > all finite buckets
    const out = m.render();
    expect(out).toContain('edge_memory_request_duration_seconds_bucket{op="query",le="10"} 0');
    expect(out).toContain('edge_memory_request_duration_seconds_bucket{op="query",le="+Inf"} 1');
    expect(out).toContain('edge_memory_request_duration_seconds_count{op="query"} 1');
  });
});

describe('Metrics — gauges', () => {
  it('entries gauge reflects setEntries', () => {
    const m = new Metrics();
    m.setEntries(42);
    expect(m.render()).toContain('edge_memory_entries_total 42');
  });

  it('idle gauge is 0 by default; 1 when set', () => {
    const m = new Metrics();
    expect(m.render()).toContain('edge_memory_idle_state 0');
    m.setIdle(true);
    expect(m.render()).toContain('edge_memory_idle_state 1');
  });
});

describe('Metrics — exposition format', () => {
  it('emits HELP + TYPE lines for every metric', () => {
    const m = new Metrics();
    const out = m.render();
    expect(out).toMatch(/# HELP edge_memory_requests_total/);
    expect(out).toMatch(/# TYPE edge_memory_requests_total counter/);
    expect(out).toMatch(/# TYPE edge_memory_errors_total counter/);
    expect(out).toMatch(/# TYPE edge_memory_request_duration_seconds histogram/);
    expect(out).toMatch(/# TYPE edge_memory_entries_total gauge/);
    expect(out).toMatch(/# TYPE edge_memory_idle_state gauge/);
  });

  it('output ends with a newline (required by Prometheus exposition spec)', () => {
    expect(new Metrics().render()).toMatch(/\n$/);
  });
});

describe('opForPath — bounded label cardinality', () => {
  it('maps known paths to op labels', () => {
    expect(opForPath('/health')).toBe('health');
    expect(opForPath('/metrics')).toBe('metrics');
    expect(opForPath('/v1/memory/put')).toBe('put');
    expect(opForPath('/v1/memory/query')).toBe('query');
    expect(opForPath('/v1/memory/forget')).toBe('forget');
    expect(opForPath('/v1/memory/export')).toBe('export');
    expect(opForPath('/v1/memory/import')).toBe('import');
    expect(opForPath('/v1/audit')).toBe('audit');
  });

  it('maps anticipated future routes (kept here so the bucket exists)', () => {
    expect(opForPath('/v1/memory/tag')).toBe('tag');
    expect(opForPath('/v1/memory/consolidate')).toBe('consolidate');
    expect(opForPath('/v1/memory/snapshot')).toBe('snapshot');
    expect(opForPath('/v1/memory/restore')).toBe('restore');
    expect(opForPath('/v1/memory/inspect')).toBe('inspect');
    expect(opForPath('/v1/memory/cleanup-unconfirmed')).toBe('cleanup');
  });

  it('lumps unknown paths into "other" so client paths cannot blow up label cardinality', () => {
    expect(opForPath('/foo/bar/baz')).toBe('other');
    expect(opForPath('/v1/memory/imaginary')).toBe('other');
  });
});

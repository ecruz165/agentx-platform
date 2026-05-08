package com.jefelabs.agentx.controlplane.job.persistence;

/**
 * Row shape for {@link JobDao#summarizeBenchmarkRun}. Wire-format-friendly
 * aggregation of one benchmark cohort: counts by terminal state plus
 * latency percentiles. Returned as a single row per run id (or absent
 * when no jobs match).
 */
public record BenchmarkRunSummaryRow(
    int total,
    int completed,
    int failed,
    int inFlight,
    int cancelled,
    String label,
    long p50LatencyMs,
    long p95LatencyMs
) {
}

package com.jefelabs.agentx.controlplane.job.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Aggregate metrics for a single benchmark run, returned by
 * {@code GET /api/benchmarks/compare}. One DTO per requested run id;
 * the response is an array so callers can lay them out side-by-side.
 *
 * <p>Latencies are millisecond percentiles over the cohort's
 * {@code completed_at - started_at} for jobs that reached a terminal
 * state. {@code total} - {@code completed} - {@code failed} -
 * {@code cancelled} = {@code inFlight} (queued + running + cancelling).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record BenchmarkRunSummaryDTO(
    String runId,
    String label,
    int total,
    int completed,
    int failed,
    int inFlight,
    int cancelled,
    long p50LatencyMs,
    long p95LatencyMs,
    double successRate
) {
}

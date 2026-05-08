package com.jefelabs.agentx.controlplane.job.domain;

import tools.jackson.databind.JsonNode;

import java.time.Instant;

/**
 * Per-step execution record. One row per (org_id, job_id, node_id, attempt).
 * Multiple rows per node when {@code RetryStep} retries (Phase 3d).
 */
public record JobStep(
    String orgId,
    String jobId,
    String nodeId,
    int attempt,
    StepStatus status,
    String harnessId,
    JsonNode input,
    JsonNode output,
    String failureReason,
    Instant startedAt,
    Instant completedAt
) {
}

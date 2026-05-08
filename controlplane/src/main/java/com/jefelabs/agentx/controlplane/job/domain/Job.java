package com.jefelabs.agentx.controlplane.job.domain;

import tools.jackson.databind.JsonNode;

import java.time.Instant;

/**
 * Domain type for an in-flight job. Persisted in the {@code jobs} table.
 *
 * <p>{@code currentNodeId} tracks where the engine is in the FlowDef (the
 * id of the FlowDef node currently running, or null if not yet started or
 * past the last node). Engine logic (Phase 3b) updates it as the walk
 * progresses.
 */
public record Job(
    String orgId,
    String id,
    String flowId,
    String productId,
    JobStatus status,
    JsonNode input,
    String setName,
    JsonNode config,
    JsonNode output,
    String failureReason,
    String currentNodeId,
    Instant createdAt,
    Instant startedAt,
    Instant completedAt,
    String createdBy
) {
}

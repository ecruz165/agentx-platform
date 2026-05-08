package com.jefelabs.agentx.controlplane.context.domain;

import java.time.Instant;
import java.util.UUID;

/**
 * Per-ingestion run. Multiple ingestion_jobs rows per source over time
 * (one per refresh). Phase 4.3 populates these via the agentx-load
 * subprocess; Phase 4.1 just defines the shape.
 */
public record IngestionJob(
    UUID id,
    String orgId,
    String sourceId,
    IngestionStatus status,
    Integer chunkCount,
    String failureReason,
    Instant createdAt,
    Instant startedAt,
    Instant completedAt
) {
}

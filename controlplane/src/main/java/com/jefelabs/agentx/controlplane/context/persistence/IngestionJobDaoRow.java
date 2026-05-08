package com.jefelabs.agentx.controlplane.context.persistence;

import com.jefelabs.agentx.controlplane.context.domain.IngestionStatus;

import java.time.Instant;
import java.util.UUID;

public record IngestionJobDaoRow(
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

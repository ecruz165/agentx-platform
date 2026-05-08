package com.jefelabs.agentx.controlplane.context.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.jefelabs.agentx.controlplane.context.domain.IngestionStatus;

import java.time.Instant;
import java.util.UUID;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record IngestionJobDTO(
    UUID id,
    String sourceId,
    IngestionStatus status,
    Integer chunkCount,
    String failureReason,
    Instant createdAt,
    Instant startedAt,
    Instant completedAt
) {
}

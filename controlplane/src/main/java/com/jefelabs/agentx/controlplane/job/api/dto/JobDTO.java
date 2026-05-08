package com.jefelabs.agentx.controlplane.job.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.jefelabs.agentx.controlplane.job.domain.JobStatus;
import tools.jackson.databind.JsonNode;

import java.time.Instant;

/**
 * Wire format for {@code Job} returned by the API. {@code set} is rendered
 * with the friendlier wire name (vs. domain {@code setName} which avoids
 * SQL-reserved-word friction).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record JobDTO(
    String id,
    String flowId,
    String productId,
    JobStatus status,
    JsonNode input,
    String set,
    JsonNode config,
    JsonNode output,
    String failureReason,
    String currentNodeId,
    String benchmarkRunId,
    String benchmarkLabel,
    Double evalScore,
    String evalRationale,
    String evalJudge,
    Instant evalScoredAt,
    Double estimatedPoints,
    Double actualPoints,
    String reflection,
    JsonNode surprises,
    Instant reflectedAt,
    Instant createdAt,
    Instant startedAt,
    Instant completedAt
) {
}

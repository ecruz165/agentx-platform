package com.jefelabs.agentx.controlplane.intent.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.jefelabs.agentx.controlplane.intent.domain.SessionStatus;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.UUID;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record IntentSessionDTO(
    UUID id,
    String userId,
    String intakePipelineId,
    String intakeJobId,
    String workJobId,
    SessionStatus status,
    JsonNode resolvedIntent,
    String failureReason,
    Instant createdAt,
    Instant lastActivityAt
) {
}

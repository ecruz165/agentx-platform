package com.jefelabs.agentx.controlplane.context.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.jefelabs.agentx.controlplane.context.domain.RefreshSchedule;
import com.jefelabs.agentx.controlplane.context.domain.SourceKind;
import tools.jackson.databind.JsonNode;

import java.time.Instant;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record ContextSourceDTO(
    String id,
    SourceKind kind,
    String target,
    String profile,
    RefreshSchedule refreshSchedule,
    JsonNode accessPolicy,
    Instant createdAt,
    Instant updatedAt
) {
}

package com.jefelabs.agentx.controlplane.eval.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import tools.jackson.databind.JsonNode;

import java.time.Instant;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record EvalSuiteDTO(
    String id,
    String name,
    String description,
    JsonNode inputs,
    Instant createdAt,
    Instant updatedAt
) {
}

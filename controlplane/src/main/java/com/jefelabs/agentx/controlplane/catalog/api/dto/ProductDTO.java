package com.jefelabs.agentx.controlplane.catalog.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import tools.jackson.databind.JsonNode;

import java.time.Instant;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record ProductDTO(
    String id,
    String description,
    JsonNode contextSources,
    JsonNode repos,
    Instant createdAt,
    Instant updatedAt
) {
}

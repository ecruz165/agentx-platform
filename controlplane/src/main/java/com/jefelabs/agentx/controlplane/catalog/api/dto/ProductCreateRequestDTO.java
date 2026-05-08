package com.jefelabs.agentx.controlplane.catalog.api.dto;

import tools.jackson.databind.JsonNode;

public record ProductCreateRequestDTO(
    String id,
    String description,
    JsonNode contextSources,
    JsonNode repos
) {
}

package com.jefelabs.agentx.controlplane.catalog.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.jefelabs.agentx.controlplane.catalog.domain.CatalogItemType;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.List;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record CatalogItemDTO(
    CatalogItemType type,
    String id,
    String name,
    String version,
    String description,
    String topic,
    List<String> tags,
    String runtime,
    JsonNode manifest,
    String source,
    Instant createdAt,
    Instant updatedAt
) {
}

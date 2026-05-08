package com.jefelabs.agentx.controlplane.catalog.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.jefelabs.agentx.controlplane.catalog.domain.SkillCategory;
import tools.jackson.databind.JsonNode;

import java.time.Instant;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record SkillDTO(
    String id,
    SkillCategory category,
    String description,
    JsonNode metadata,
    Instant createdAt,
    Instant updatedAt
) {
}

package com.jefelabs.agentx.controlplane.catalog.api.dto;

import com.jefelabs.agentx.controlplane.catalog.domain.SkillCategory;
import tools.jackson.databind.JsonNode;

public record SkillCreateRequestDTO(
    String id,
    SkillCategory category,
    String description,
    JsonNode metadata
) {
}

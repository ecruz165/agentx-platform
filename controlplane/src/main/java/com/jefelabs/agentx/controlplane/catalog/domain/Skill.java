package com.jefelabs.agentx.controlplane.catalog.domain;

import tools.jackson.databind.JsonNode;

import java.time.Instant;

/**
 * Domain type for a skill (skillzkit catalog entry — router/tool/integration/
 * task/workflow). Represents a *reference* to skillzkit-managed content;
 * actual procurement happens in the workspace CLI at install time.
 */
public record Skill(
    String orgId,
    String id,
    SkillCategory category,
    String description,
    JsonNode metadata,
    Instant createdAt,
    Instant updatedAt,
    String createdBy,
    String updatedBy
) {
}

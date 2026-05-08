package com.jefelabs.agentx.controlplane.catalog.persistence;

import com.jefelabs.agentx.controlplane.catalog.domain.SkillCategory;

import java.time.Instant;

public record SkillDaoRow(
    String orgId,
    String id,
    SkillCategory category,
    String description,
    String metadata,
    Instant createdAt,
    Instant updatedAt,
    String createdBy,
    String updatedBy
) {
}

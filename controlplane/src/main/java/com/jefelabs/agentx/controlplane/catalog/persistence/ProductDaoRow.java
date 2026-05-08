package com.jefelabs.agentx.controlplane.catalog.persistence;

import java.time.Instant;

public record ProductDaoRow(
    String orgId,
    String id,
    String description,
    String contextSources,
    String repos,
    Instant createdAt,
    Instant updatedAt,
    String createdBy,
    String updatedBy
) {
}

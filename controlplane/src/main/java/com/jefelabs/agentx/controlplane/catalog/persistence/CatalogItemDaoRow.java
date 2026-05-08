package com.jefelabs.agentx.controlplane.catalog.persistence;

import com.jefelabs.agentx.controlplane.catalog.domain.CatalogItemType;

import java.time.Instant;

public record CatalogItemDaoRow(
    String orgId,
    CatalogItemType type,
    String id,
    String name,
    String version,
    String description,
    String topic,
    String[] tags,
    String runtime,
    String manifest,
    String source,
    Instant createdAt,
    Instant updatedAt
) {
}

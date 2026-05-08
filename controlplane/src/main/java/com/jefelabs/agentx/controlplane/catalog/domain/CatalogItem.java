package com.jefelabs.agentx.controlplane.catalog.domain;

import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.List;

/**
 * Unified catalog item — covers all 6 skillzkit types (skill, workflow,
 * prompt, persona, context, template). Field shape mirrors skillzkit's
 * {@code manifest.yaml} so a sync from skillzkit can land the row
 * without lossy projection; the full original manifest is preserved in
 * {@link #manifest}.
 */
public record CatalogItem(
    String orgId,
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

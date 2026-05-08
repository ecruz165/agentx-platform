package com.jefelabs.agentx.controlplane.catalog.domain;

import tools.jackson.databind.JsonNode;

import java.time.Instant;

/**
 * Domain type for a product. Mirrors TS-side {@code ProductDef}:
 *   { id, description?, contextSources?, repos? }
 *
 * <p>Both {@code contextSources} and {@code repos} are stored as JSON arrays
 * of typed objects ({@code ContextSourceDef[]} / {@code ProductRepo[]}).
 */
public record Product(
    String orgId,
    String id,
    String description,
    JsonNode contextSources,
    JsonNode repos,
    Instant createdAt,
    Instant updatedAt,
    String createdBy,
    String updatedBy
) {
}

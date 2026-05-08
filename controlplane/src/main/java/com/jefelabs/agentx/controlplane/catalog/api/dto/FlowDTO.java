package com.jefelabs.agentx.controlplane.catalog.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.jefelabs.agentx.controlplane.catalog.domain.FlowKind;
import tools.jackson.databind.JsonNode;

import java.time.Instant;

/**
 * Wire format for a {@code Flow} returned by the catalog API. Mirrors the
 * TS-side {@code FlowDef} contract from {@code harness-core/src/catalog.ts}
 * plus org-scoped audit metadata.
 *
 * <p>{@link JsonInclude.Include#NON_NULL} suppresses absent optional fields
 * (e.g., {@code description}, {@code output}) in JSON output to match the
 * TS-side ergonomic.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record FlowDTO(
    String id,
    String description,
    FlowKind kind,
    JsonNode output,
    JsonNode nodes,
    JsonNode edges,
    Instant createdAt,
    Instant updatedAt
) {
}

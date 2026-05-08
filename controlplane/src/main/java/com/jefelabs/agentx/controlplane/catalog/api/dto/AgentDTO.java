package com.jefelabs.agentx.controlplane.catalog.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.jefelabs.agentx.controlplane.catalog.domain.AdapterId;
import tools.jackson.databind.JsonNode;

import java.time.Instant;

/**
 * Wire format for an {@code Agent} returned by the catalog API. Mirrors the
 * TS-side {@code AgentDef} contract.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AgentDTO(
    String id,
    String role,
    AdapterId adapter,
    String systemPrompt,
    JsonNode config,
    JsonNode accepts,
    JsonNode fallbackOn,
    JsonNode skillz,
    Instant createdAt,
    Instant updatedAt
) {
}

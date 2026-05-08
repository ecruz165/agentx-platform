package com.jefelabs.agentx.controlplane.catalog.api.dto;

import com.jefelabs.agentx.controlplane.catalog.domain.AdapterId;
import tools.jackson.databind.JsonNode;

/**
 * Wire format for {@code POST /api/catalog/agents}. Mirrors TS-side
 * {@code AgentDef} (id is caller-supplied — agents are referenced by stable
 * string ids).
 */
public record AgentCreateRequestDTO(
    String id,
    String role,
    AdapterId adapter,
    String systemPrompt,
    JsonNode config,
    JsonNode accepts,
    JsonNode fallbackOn,
    JsonNode skillz
) {
}

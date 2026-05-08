package com.jefelabs.agentx.controlplane.context.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import tools.jackson.databind.JsonNode;

/**
 * One ranked chunk in the query response. Shape mirrors edge-context-server's
 * response per prd-context-module.md F9 (drop-in compat for harness clients
 * that fan out to both layers).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ChunkDTO(
    String text,
    double score,
    String sourceId,
    JsonNode metadata
) {
}

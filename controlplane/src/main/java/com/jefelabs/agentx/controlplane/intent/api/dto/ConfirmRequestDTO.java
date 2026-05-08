package com.jefelabs.agentx.controlplane.intent.api.dto;

import tools.jackson.databind.JsonNode;

/**
 * Wire format for {@code POST /api/intent/sessions/{id}/confirm}.
 * Mirrors the {@link com.jefelabs.agentx.controlplane.core.types.JobIntent}
 * shape — Phase 5.3 has the caller pass the resolved intent explicitly
 * (Phase 5.5 will pull it from the intake job's
 * {@code job-intent-produced} event).
 */
public record ConfirmRequestDTO(
    String flowId,
    String productId,
    JsonNode input,
    String set,
    JsonNode config
) {
}

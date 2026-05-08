package com.jefelabs.agentx.controlplane.job.api.dto;

import tools.jackson.databind.JsonNode;

/**
 * Wire format for {@code POST /api/jobs}. Mirrors the {@link
 * com.jefelabs.agentx.controlplane.core.types.JobIntent} shape exactly —
 * the controller hands the unpacked record (or a JobIntent) to the service.
 *
 * <p>The Intent module produces {@code JobIntent} programmatically and
 * calls the same service entry point — the chat surface and direct REST
 * surface converge at the service boundary.
 */
public record SubmitJobRequestDTO(
    String flowId,
    String productId,
    JsonNode input,
    String set,
    JsonNode config
) {
}

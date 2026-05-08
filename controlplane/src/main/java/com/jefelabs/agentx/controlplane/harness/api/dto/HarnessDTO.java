package com.jefelabs.agentx.controlplane.harness.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.jefelabs.agentx.controlplane.harness.domain.HarnessStatus;
import tools.jackson.databind.JsonNode;

import java.time.Instant;

/**
 * Wire format for a registered harness. {@code sessionToken} is included
 * in the *response* of {@link RegisterHarnessRequestDTO} only — never in
 * read-side responses (defense-in-depth even before Phase 7 auth lands).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record HarnessDTO(
    String id,
    String name,
    String version,
    HarnessStatus status,
    String region,
    JsonNode capabilities,
    JsonNode endpoints,
    Integer currentLoad,
    Instant lastHeartbeatAt,
    Instant registeredAt
) {
}

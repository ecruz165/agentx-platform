package com.jefelabs.agentx.controlplane.dispatch.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Wire format for {@code POST /api/dispatch/route}. {@code harnessId} is
 * populated when routing succeeds; {@code reason} when no eligible harness
 * was found. Mutually exclusive — one is always null.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record RouteStepResponseDTO(
    String harnessId,
    String policyUsed,
    Integer eligibleCount,
    String reason
) {
}

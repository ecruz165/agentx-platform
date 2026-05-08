package com.jefelabs.agentx.controlplane.dispatch.api.dto;

import com.jefelabs.agentx.controlplane.dispatch.domain.StepContext;

import java.util.List;

/**
 * Wire format for {@code POST /api/dispatch/route} (debug/test endpoint).
 * Real callers (the Job module at Phase 3) call {@code HarnessRouter.routeStep}
 * directly via Spring DI — no HTTP hop within the modulith.
 */
public record RouteStepRequestDTO(
    String jobId,
    String stepId,
    String productId,
    List<String> requiredCapabilities,
    StepContext.AffinityHint affinityHint
) {
}

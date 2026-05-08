package com.jefelabs.agentx.controlplane.dispatch.domain;

import java.util.List;

/**
 * Input to {@code HarnessRouter.routeStep(StepContext)}. Mirrors prd-dispatch-module.md F1.
 *
 * <p>{@code requiredCapabilities} and {@code affinityHint} are advisory at
 * Phase 2 MVP — round-robin ignores both. Full capability filtering + sticky
 * affinity land in dispatch module's Phase 2.x once the round-robin shape
 * stabilizes.
 */
public record StepContext(
    String orgId,
    String jobId,
    String stepId,
    String productId,
    List<String> requiredCapabilities,
    AffinityHint affinityHint
) {
    public enum AffinityHint {
        NONE,
        STICKY_TO_JOB_ORIGIN
    }
}

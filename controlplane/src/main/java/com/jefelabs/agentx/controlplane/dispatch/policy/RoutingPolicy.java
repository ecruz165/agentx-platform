package com.jefelabs.agentx.controlplane.dispatch.policy;

import com.jefelabs.agentx.controlplane.dispatch.domain.StepContext;
import com.jefelabs.agentx.controlplane.harness.domain.Harness;

import java.util.List;
import java.util.Optional;

/**
 * Pluggable routing policy per prd-dispatch-module.md F13. Phase 2 MVP ships
 * {@link RoundRobinPolicy} only; sticky-affinity, least-loaded, and
 * cost-aware policies arrive in Phase 2.x.
 */
public interface RoutingPolicy {

    /** Policy name surfaced in the audit log. */
    String name();

    /**
     * Pick a harness from {@code eligible} for the step described by {@code context}.
     * Returns empty when {@code eligible} is empty (caller handles the
     * {@code NoEligibleHarness} response).
     */
    Optional<Harness> select(List<Harness> eligible, StepContext context);
}

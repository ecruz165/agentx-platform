package com.jefelabs.agentx.controlplane.dispatch.domain;

/**
 * Result of {@code HarnessRouter.routeStep(StepContext)}. Either a chosen
 * {@code harnessId} or an explanation why no harness was eligible.
 */
public sealed interface RoutingDecision {

    record Routed(String harnessId, String policyUsed, int eligibleCount) implements RoutingDecision {}

    record NoEligibleHarness(String reason) implements RoutingDecision {}
}

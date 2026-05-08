/**
 * Dispatch domain types — exposed as a named interface so consumers
 * (currently {@code job}'s engine) can hold {@link StepContext} +
 * {@link RoutingDecision} references.
 */
@org.springframework.modulith.NamedInterface("domain")
package com.jefelabs.agentx.controlplane.dispatch.domain;

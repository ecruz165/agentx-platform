/**
 * Harness module domain types. Exposed as a named interface so consumers
 * (currently Dispatch) can hold {@link Harness} / {@link HarnessStatus}
 * references returned by {@code harness.service} APIs.
 */
@org.springframework.modulith.NamedInterface("domain")
package com.jefelabs.agentx.controlplane.harness.domain;

package com.jefelabs.agentx.controlplane.harness.domain;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Harness liveness state. Mirrors the four states described in
 * prd-harness-module.md §6.2.
 *
 * <p>Phase 2 MVP transitions are explicit (registration / heartbeat /
 * deregister); time-based transitions to {@link #UNHEALTHY} +
 * {@link #DISCONNECTED} arrive with the eviction scheduler in Phase 2.x.
 */
public enum HarnessStatus {
    @JsonProperty("registered") REGISTERED,
    @JsonProperty("active")     ACTIVE,
    @JsonProperty("unhealthy")  UNHEALTHY,
    @JsonProperty("disconnected") DISCONNECTED;

    public String dbValue() {
        return switch (this) {
            case REGISTERED -> "registered";
            case ACTIVE -> "active";
            case UNHEALTHY -> "unhealthy";
            case DISCONNECTED -> "disconnected";
        };
    }

    public static HarnessStatus fromDbValue(String value) {
        return switch (value) {
            case "registered" -> REGISTERED;
            case "active" -> ACTIVE;
            case "unhealthy" -> UNHEALTHY;
            case "disconnected" -> DISCONNECTED;
            default -> throw new IllegalArgumentException("Unknown HarnessStatus dbValue: " + value);
        };
    }
}

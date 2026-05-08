package com.jefelabs.agentx.controlplane.context.domain;

import com.fasterxml.jackson.annotation.JsonProperty;

/** Refresh cadence for an ingested source. Phase 4.4 wires the @Scheduled poller. */
public enum RefreshSchedule {
    @JsonProperty("daily")   DAILY,
    @JsonProperty("weekly")  WEEKLY,
    @JsonProperty("manual")  MANUAL;

    public String dbValue() {
        return switch (this) {
            case DAILY -> "daily";
            case WEEKLY -> "weekly";
            case MANUAL -> "manual";
        };
    }

    public static RefreshSchedule fromDbValue(String value) {
        return switch (value) {
            case "daily" -> DAILY;
            case "weekly" -> WEEKLY;
            case "manual" -> MANUAL;
            default -> throw new IllegalArgumentException("Unknown RefreshSchedule dbValue: " + value);
        };
    }
}

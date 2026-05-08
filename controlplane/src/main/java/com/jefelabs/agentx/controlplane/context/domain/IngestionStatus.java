package com.jefelabs.agentx.controlplane.context.domain;

import com.fasterxml.jackson.annotation.JsonProperty;

public enum IngestionStatus {
    @JsonProperty("pending")   PENDING,
    @JsonProperty("running")   RUNNING,
    @JsonProperty("completed") COMPLETED,
    @JsonProperty("failed")    FAILED;

    public String dbValue() {
        return switch (this) {
            case PENDING -> "pending";
            case RUNNING -> "running";
            case COMPLETED -> "completed";
            case FAILED -> "failed";
        };
    }

    public static IngestionStatus fromDbValue(String value) {
        return switch (value) {
            case "pending" -> PENDING;
            case "running" -> RUNNING;
            case "completed" -> COMPLETED;
            case "failed" -> FAILED;
            default -> throw new IllegalArgumentException("Unknown IngestionStatus dbValue: " + value);
        };
    }
}

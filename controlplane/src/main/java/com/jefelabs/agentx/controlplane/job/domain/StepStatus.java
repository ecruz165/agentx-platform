package com.jefelabs.agentx.controlplane.job.domain;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Per-step lifecycle. Mirrors {@code prd-job-module.md} F3.
 *
 * <p>Transitions: pending → running → (completed | failed | skipped).
 * Skipped applies to fork/conditional branches that don't fire.
 */
public enum StepStatus {
    @JsonProperty("pending")   PENDING,
    @JsonProperty("running")   RUNNING,
    @JsonProperty("completed") COMPLETED,
    @JsonProperty("failed")    FAILED,
    @JsonProperty("skipped")   SKIPPED;

    public String dbValue() {
        return switch (this) {
            case PENDING -> "pending";
            case RUNNING -> "running";
            case COMPLETED -> "completed";
            case FAILED -> "failed";
            case SKIPPED -> "skipped";
        };
    }

    public static StepStatus fromDbValue(String value) {
        return switch (value) {
            case "pending" -> PENDING;
            case "running" -> RUNNING;
            case "completed" -> COMPLETED;
            case "failed" -> FAILED;
            case "skipped" -> SKIPPED;
            default -> throw new IllegalArgumentException("Unknown StepStatus dbValue: " + value);
        };
    }

    public boolean isTerminal() {
        return this == COMPLETED || this == FAILED || this == SKIPPED;
    }
}

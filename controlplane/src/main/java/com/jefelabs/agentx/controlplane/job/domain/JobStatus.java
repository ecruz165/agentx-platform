package com.jefelabs.agentx.controlplane.job.domain;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Job lifecycle states. Mirrors {@code prd-job-module.md} F2.
 *
 * <p>Transitions (Phase 3a explicit set; engine in Phase 3b adds the rest):
 * <pre>
 *   queued ──▶ running ──▶ completed
 *           │           ├─▶ failed
 *           │           └─▶ cancelling ──▶ cancelled
 *           └────────────────▶ cancelled  (cancel-while-queued)
 * </pre>
 */
public enum JobStatus {
    @JsonProperty("queued")     QUEUED,
    @JsonProperty("running")    RUNNING,
    @JsonProperty("completed")  COMPLETED,
    @JsonProperty("failed")     FAILED,
    @JsonProperty("cancelling") CANCELLING,
    @JsonProperty("cancelled")  CANCELLED;

    public String dbValue() {
        return switch (this) {
            case QUEUED -> "queued";
            case RUNNING -> "running";
            case COMPLETED -> "completed";
            case FAILED -> "failed";
            case CANCELLING -> "cancelling";
            case CANCELLED -> "cancelled";
        };
    }

    public static JobStatus fromDbValue(String value) {
        return switch (value) {
            case "queued" -> QUEUED;
            case "running" -> RUNNING;
            case "completed" -> COMPLETED;
            case "failed" -> FAILED;
            case "cancelling" -> CANCELLING;
            case "cancelled" -> CANCELLED;
            default -> throw new IllegalArgumentException("Unknown JobStatus dbValue: " + value);
        };
    }

    public boolean isTerminal() {
        return this == COMPLETED || this == FAILED || this == CANCELLED;
    }
}

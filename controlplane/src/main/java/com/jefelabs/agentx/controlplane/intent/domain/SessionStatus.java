package com.jefelabs.agentx.controlplane.intent.domain;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Lifecycle of an intake session per prd-intent-module.md F2.
 * Wire format uses lowercase-hyphenated names; database stores the same.
 */
public enum SessionStatus {
    @JsonProperty("awaiting-message") AWAITING_MESSAGE,
    @JsonProperty("processing")       PROCESSING,
    @JsonProperty("intent-ready")     INTENT_READY,
    @JsonProperty("submitted")        SUBMITTED,
    @JsonProperty("expired")          EXPIRED,
    @JsonProperty("aborted")          ABORTED,
    @JsonProperty("failed")           FAILED;

    public String dbValue() {
        return switch (this) {
            case AWAITING_MESSAGE -> "awaiting-message";
            case PROCESSING       -> "processing";
            case INTENT_READY     -> "intent-ready";
            case SUBMITTED        -> "submitted";
            case EXPIRED          -> "expired";
            case ABORTED          -> "aborted";
            case FAILED           -> "failed";
        };
    }

    public static SessionStatus fromDbValue(String v) {
        return switch (v) {
            case "awaiting-message" -> AWAITING_MESSAGE;
            case "processing"       -> PROCESSING;
            case "intent-ready"     -> INTENT_READY;
            case "submitted"        -> SUBMITTED;
            case "expired"          -> EXPIRED;
            case "aborted"          -> ABORTED;
            case "failed"           -> FAILED;
            default -> throw new IllegalArgumentException("Unknown SessionStatus: " + v);
        };
    }
}

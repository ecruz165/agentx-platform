package com.jefelabs.agentx.controlplane.proposals.domain;

import com.fasterxml.jackson.annotation.JsonProperty;

public enum ProposalStatus {
    @JsonProperty("proposed") PROPOSED,
    @JsonProperty("approved") APPROVED,
    @JsonProperty("rejected") REJECTED;

    public String dbValue() {
        return switch (this) {
            case PROPOSED -> "proposed";
            case APPROVED -> "approved";
            case REJECTED -> "rejected";
        };
    }

    public static ProposalStatus fromDbValue(String v) {
        return switch (v) {
            case "proposed" -> PROPOSED;
            case "approved" -> APPROVED;
            case "rejected" -> REJECTED;
            default -> throw new IllegalArgumentException("Unknown ProposalStatus: " + v);
        };
    }
}

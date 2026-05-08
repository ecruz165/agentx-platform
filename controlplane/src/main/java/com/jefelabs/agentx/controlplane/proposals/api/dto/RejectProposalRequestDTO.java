package com.jefelabs.agentx.controlplane.proposals.api.dto;

/** Wire format for {@code POST /api/skill-proposals/{id}/reject}. */
public record RejectProposalRequestDTO(String reason) {
}

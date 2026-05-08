package com.jefelabs.agentx.controlplane.intent.api.dto;

/** Wire format for {@code POST /api/intent/sessions/{id}/reject-pipeline-creation}. */
public record RejectPipelineRequestDTO(String reason) {
}

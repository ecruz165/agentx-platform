package com.jefelabs.agentx.controlplane.intent.api.dto;

/** Wire format for {@code POST /api/intent/sessions/{id}/messages}. */
public record MessageRequestDTO(String message) {
}

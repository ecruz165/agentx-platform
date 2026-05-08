package com.jefelabs.agentx.controlplane.intent.domain;

import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.UUID;

/**
 * Domain model for an intake session per prd-intent-module.md F19.
 * Conversation content lives in the underlying intake job's event log;
 * this record only tracks session-level state.
 */
public record IntentSession(
    UUID id,
    String orgId,
    String userId,
    String intakePipelineId,
    String intakeJobId,
    String workJobId,
    SessionStatus status,
    JsonNode resolvedIntent,
    String failureReason,
    Instant createdAt,
    Instant lastActivityAt
) {
}

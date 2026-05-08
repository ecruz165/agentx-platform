package com.jefelabs.agentx.controlplane.intent.persistence;

import com.jefelabs.agentx.controlplane.intent.domain.SessionStatus;

import java.time.Instant;
import java.util.UUID;

public record SessionDaoRow(
    UUID id,
    String orgId,
    String userId,
    String intakePipelineId,
    String intakeJobId,
    String workJobId,
    SessionStatus status,
    String resolvedIntent,
    String failureReason,
    Instant createdAt,
    Instant lastActivityAt
) {
}

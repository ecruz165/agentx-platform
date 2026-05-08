package com.jefelabs.agentx.controlplane.context.persistence;

import com.jefelabs.agentx.controlplane.context.domain.RefreshSchedule;
import com.jefelabs.agentx.controlplane.context.domain.SourceKind;

import java.time.Instant;

public record ContextSourceDaoRow(
    String orgId,
    String id,
    SourceKind kind,
    String target,
    String profile,
    RefreshSchedule refreshSchedule,
    String accessPolicy,
    Instant createdAt,
    Instant updatedAt,
    String createdBy
) {
}

package com.jefelabs.agentx.controlplane.eval.persistence;

import java.time.Instant;

public record EvalSuiteDaoRow(
    String orgId,
    String id,
    String name,
    String description,
    String inputs,
    Instant createdAt,
    Instant updatedAt,
    String createdBy
) {
}

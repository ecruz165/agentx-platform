package com.jefelabs.agentx.controlplane.harness.persistence;

import com.jefelabs.agentx.controlplane.harness.domain.HarnessStatus;

import java.time.Instant;

public record HarnessDaoRow(
    String orgId,
    String id,
    String name,
    String version,
    HarnessStatus status,
    String region,
    String capabilities,
    String endpoints,
    Integer currentLoad,
    String currentJobs,
    String sessionToken,
    Instant lastHeartbeatAt,
    Instant registeredAt,
    Instant updatedAt
) {
}

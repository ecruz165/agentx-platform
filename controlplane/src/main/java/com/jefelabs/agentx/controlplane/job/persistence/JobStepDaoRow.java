package com.jefelabs.agentx.controlplane.job.persistence;

import com.jefelabs.agentx.controlplane.job.domain.StepStatus;

import java.time.Instant;

public record JobStepDaoRow(
    String orgId,
    String jobId,
    String nodeId,
    int attempt,
    StepStatus status,
    String harnessId,
    String input,
    String output,
    String failureReason,
    Instant startedAt,
    Instant completedAt
) {
}

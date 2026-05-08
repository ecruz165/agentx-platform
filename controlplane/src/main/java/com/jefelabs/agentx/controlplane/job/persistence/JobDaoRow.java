package com.jefelabs.agentx.controlplane.job.persistence;

import com.jefelabs.agentx.controlplane.job.domain.JobStatus;

import java.time.Instant;

public record JobDaoRow(
    String orgId,
    String id,
    String flowId,
    String productId,
    JobStatus status,
    String input,
    String setName,
    String config,
    String output,
    String failureReason,
    String currentNodeId,
    String benchmarkRunId,
    String benchmarkLabel,
    Instant createdAt,
    Instant startedAt,
    Instant completedAt,
    String createdBy
) {
}

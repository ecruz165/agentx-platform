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
    Double evalScore,
    String evalRationale,
    String evalJudge,
    Instant evalScoredAt,
    Double estimatedPoints,
    Double actualPoints,
    String reflection,
    String surprises,
    Instant reflectedAt,
    Instant createdAt,
    Instant startedAt,
    Instant completedAt,
    String createdBy
) {
}

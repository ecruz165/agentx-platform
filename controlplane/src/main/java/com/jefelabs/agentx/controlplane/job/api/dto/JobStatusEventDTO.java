package com.jefelabs.agentx.controlplane.job.api.dto;

/**
 * Wire format for {@code POST /api/jobs/&#123;id&#125;/status} — a
 * job-status transition pushed back by a harness-server (W1d).
 *
 * <p>{@code status} is harness-server's vocabulary
 * ({@code received|running|awaiting-approval|suspended|completed|failed|cancelled});
 * the service maps it to the controlplane's {@code JobStatus}.
 * {@code failureReason} is set only for {@code failed} transitions.
 */
public record JobStatusEventDTO(
    String status,
    String failureReason
) {
}

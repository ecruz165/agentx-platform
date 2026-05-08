package com.jefelabs.agentx.controlplane.harness.api.dto;

import tools.jackson.databind.JsonNode;

/**
 * Wire format for {@code POST /api/registry/heartbeat}. Per prd-harness-module.md F7.
 * {@code currentLoad} + {@code healthOk} are informational; the Dispatch
 * module may use {@code currentLoad} for fairness in v1.x.
 *
 * <p>{@code currentJobs} is the harness-server's
 * {@code GET /v1/dispatcher/status} snapshot ({@code capacity},
 * {@code inFlight}, {@code queued}). Persisted as JSONB on the harness
 * row so admins can see in-flight jobs without per-job RPC. Stale by
 * &lt;= heartbeat interval (default 30s).
 */
public record HeartbeatRequestDTO(
    String harnessId,
    String sessionToken,
    Integer currentLoad,
    Boolean healthOk,
    JsonNode currentJobs
) {
}

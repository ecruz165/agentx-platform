package com.jefelabs.agentx.controlplane.harness.api.dto;

/**
 * Wire format for {@code POST /api/registry/heartbeat}. Per prd-harness-module.md F7.
 * {@code currentLoad} + {@code healthOk} are informational; the Dispatch
 * module may use {@code currentLoad} for fairness in v1.x.
 */
public record HeartbeatRequestDTO(
    String harnessId,
    String sessionToken,
    Integer currentLoad,
    Boolean healthOk
) {
}

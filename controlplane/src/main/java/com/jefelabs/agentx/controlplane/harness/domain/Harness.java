package com.jefelabs.agentx.controlplane.harness.domain;

import tools.jackson.databind.JsonNode;

import java.time.Instant;

/**
 * Domain type for a registered harness instance. Per prd-harness-module.md
 * §6.5: tracks the discovery facts (id, name, version, status, region,
 * capabilities, endpoints, last heartbeat) so the dispatch module can
 * filter + select harnesses for step execution.
 *
 * <p>Capabilities + endpoints are opaque {@link JsonNode}s at this layer;
 * shape rules (e.g., capabilities must declare {@code adapters[]} and
 * {@code providers[]}) are enforced via JSON Schema at Phase 2.x.
 */
public record Harness(
    String orgId,
    String id,
    String name,
    String version,
    HarnessStatus status,
    String region,
    JsonNode capabilities,
    JsonNode endpoints,
    Integer currentLoad,
    /**
     * Snapshot of the harness's in-flight jobs at the most recent
     * heartbeat. Shape mirrors harness-server's DispatcherState
     * statusSnapshot: {@code {capacity, inFlight, queued}}. Null until
     * the harness has reported.
     */
    JsonNode currentJobs,
    String sessionToken,
    Instant lastHeartbeatAt,
    Instant registeredAt,
    Instant updatedAt
) {
}

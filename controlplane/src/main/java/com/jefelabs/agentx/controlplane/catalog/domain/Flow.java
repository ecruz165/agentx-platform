package com.jefelabs.agentx.controlplane.catalog.domain;

import tools.jackson.databind.JsonNode;

import java.time.Instant;

/**
 * Domain type for a flow definition. Mirrors the wire-level shape from
 * TS-side {@code FlowDef} (graph of {@code nodes} + {@code edges}) but holds
 * the JSON-typed fields as opaque {@link JsonNode} until validation lands
 * (catalog module PRD §6.3 — Phase 2 of the catalog phased delivery).
 *
 * <p>Domain types live in {@code catalog.domain} per the layering convention
 * captured in {@code feedback_controller_service_layering.md} — they never
 * cross into the controller layer; the {@code FlowDTO} pair handles wire format.
 */
public record Flow(
    String orgId,
    String id,
    String description,
    FlowKind kind,
    JsonNode output,
    JsonNode nodes,
    JsonNode edges,
    Instant createdAt,
    Instant updatedAt,
    String createdBy,
    String updatedBy
) {
}

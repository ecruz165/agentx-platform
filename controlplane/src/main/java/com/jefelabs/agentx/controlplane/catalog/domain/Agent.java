package com.jefelabs.agentx.controlplane.catalog.domain;

import tools.jackson.databind.JsonNode;

import java.time.Instant;

/**
 * Domain type for an agent definition. Mirrors TS-side {@code AgentDef}
 * (harness-core/src/catalog.ts) — id, role, adapter, prompt, config,
 * accepts (provider:model bindings), fallbackOn (error class names),
 * skillz (skillzkit references).
 *
 * <p>JSON-typed fields ({@code config}, {@code accepts}, {@code fallbackOn},
 * {@code skillz}) held opaquely as {@link JsonNode} until validation lands
 * (catalog module PRD §6.3 — Phase 2 of the catalog phased delivery).
 */
public record Agent(
    String orgId,
    String id,
    String role,
    AdapterId adapter,
    String systemPrompt,
    JsonNode config,
    JsonNode accepts,
    JsonNode fallbackOn,
    JsonNode skillz,
    Instant createdAt,
    Instant updatedAt,
    String createdBy,
    String updatedBy
) {
}

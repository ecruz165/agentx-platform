package com.jefelabs.agentx.controlplane.context.domain;

import tools.jackson.databind.JsonNode;

import java.time.Instant;

/**
 * Domain type for a registered knowledge source. Mirrors
 * prd-context-module.md F1's source-registration shape.
 *
 * <p>{@code accessPolicy} is opaque JSON at this layer; the wire shape
 * matches {@code { allowedProductIds: string[] | "all" }}.
 */
public record ContextSource(
    String orgId,
    String id,
    SourceKind kind,
    String target,
    String profile,
    RefreshSchedule refreshSchedule,
    JsonNode accessPolicy,
    Instant createdAt,
    Instant updatedAt,
    String createdBy
) {
}

package com.jefelabs.agentx.controlplane.catalog.sse;

/**
 * Published by FlowService / ProductService (et al.) on upsert / delete.
 * The {@link CatalogEventBus} listens to these and fans out SSE
 * notifications to subscribers (typically harness-server instances
 * that want live catalog refresh without a process restart).
 *
 * <p>Payload is intentionally minimal — kind + id + op. Subscribers
 * re-fetch the canonical catalog from the HTTP API on receipt; this
 * event just signals "something changed" and "what category." Avoids
 * shipping the full new state through the event bus and through the
 * HTTP wire format, which is brittle as fields evolve.
 */
public record CatalogChangedEvent(
    String orgId,
    String kind,         // "flow" | "product"
    String id,
    String op            // "upsert" | "delete"
) {
}

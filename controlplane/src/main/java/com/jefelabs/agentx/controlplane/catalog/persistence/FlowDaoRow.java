package com.jefelabs.agentx.controlplane.catalog.persistence;

import com.jefelabs.agentx.controlplane.catalog.domain.FlowKind;

import java.time.Instant;

/**
 * Raw row shape returned by {@link FlowDao} queries. JSONB columns surface as
 * {@code String} (the SQL projection casts {@code ::text}); the service layer
 * is responsible for parsing them into Jackson {@code JsonNode}s for the
 * domain {@link com.jefelabs.agentx.controlplane.catalog.domain.Flow}.
 *
 * <p>Lives at the persistence boundary; never crosses into the service
 * signature on its own — the service repackages it into a domain record.
 */
public record FlowDaoRow(
    String orgId,
    String id,
    String description,
    FlowKind kind,
    String output,
    String nodes,
    String edges,
    Instant createdAt,
    Instant updatedAt,
    String createdBy,
    String updatedBy
) {
}

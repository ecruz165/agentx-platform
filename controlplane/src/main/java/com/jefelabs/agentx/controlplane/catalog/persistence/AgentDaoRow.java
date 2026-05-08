package com.jefelabs.agentx.controlplane.catalog.persistence;

import com.jefelabs.agentx.controlplane.catalog.domain.AdapterId;

import java.time.Instant;

/**
 * Raw row shape returned by {@link AgentDao} queries. JSONB columns surface
 * as {@code String} (SQL projection casts {@code ::text}); the service layer
 * parses them into Jackson {@code JsonNode}s for the domain
 * {@link com.jefelabs.agentx.controlplane.catalog.domain.Agent}.
 */
public record AgentDaoRow(
    String orgId,
    String id,
    String role,
    AdapterId adapter,
    String systemPrompt,
    String config,
    String accepts,
    String fallbackOn,
    String skillz,
    Instant createdAt,
    Instant updatedAt,
    String createdBy,
    String updatedBy
) {
}

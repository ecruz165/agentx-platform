package com.jefelabs.agentx.controlplane.catalog.api.dto;

import com.jefelabs.agentx.controlplane.catalog.domain.FlowKind;
import tools.jackson.databind.JsonNode;

/**
 * Wire format for {@code POST /api/catalog/flows}. Mirrors the TS-side
 * {@code FlowDef} input contract (id is caller-supplied — flows are
 * referenced by stable string ids, not server-generated ULIDs).
 *
 * <p>{@code kind} defaults to {@link FlowKind#WORK} when absent in the
 * request body (handled at mapping time, not here).
 */
public record FlowCreateRequestDTO(
    String id,
    String description,
    FlowKind kind,
    JsonNode output,
    JsonNode nodes,
    JsonNode edges
) {
}

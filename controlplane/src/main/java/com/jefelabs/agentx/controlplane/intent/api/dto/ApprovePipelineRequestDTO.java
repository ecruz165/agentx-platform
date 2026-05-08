package com.jefelabs.agentx.controlplane.intent.api.dto;

import com.jefelabs.agentx.controlplane.catalog.domain.FlowKind;
import tools.jackson.databind.JsonNode;

/**
 * Wire format for {@code POST /api/intent/sessions/{id}/approve-pipeline-creation}
 * per prd-intent-module.md F15.
 *
 * <p>Mirrors the catalog FlowCreateRequestDTO shape — the approver is
 * effectively saying "create this pipeline in the catalog." Phase 5.6
 * has the caller pass the full PipelineDef; once the architect agent
 * lands, the UI will pre-fill this from the {@code pipeline-creation-required}
 * SSE event.
 */
public record ApprovePipelineRequestDTO(
    String id,
    String description,
    FlowKind kind,
    JsonNode output,
    JsonNode nodes,
    JsonNode edges
) {
}

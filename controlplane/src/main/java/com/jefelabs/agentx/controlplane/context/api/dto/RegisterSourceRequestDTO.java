package com.jefelabs.agentx.controlplane.context.api.dto;

import com.jefelabs.agentx.controlplane.context.domain.RefreshSchedule;
import com.jefelabs.agentx.controlplane.context.domain.SourceKind;
import tools.jackson.databind.JsonNode;

/**
 * Wire format for {@code POST /api/context/sources}. Per prd-context-module.md F1:
 *   { kind, target, profile?, refreshSchedule?, accessPolicy? }
 * Caller-supplied {@code id} is required for now (deterministic source ids
 * are simpler than server-assigned for the org-wide cache use case).
 */
public record RegisterSourceRequestDTO(
    String id,
    SourceKind kind,
    String target,
    String profile,
    RefreshSchedule refreshSchedule,
    JsonNode accessPolicy
) {
}

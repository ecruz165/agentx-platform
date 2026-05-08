package com.jefelabs.agentx.controlplane.core.events;

import tools.jackson.databind.JsonNode;

/**
 * Published when a {@code pipeline-architect} sub-pipeline produces a
 * proposed PipelineDef (per prd-intent-module.md F13). Listeners — the
 * Intent module — flag the corresponding session as
 * {@code pipeline-creation-required} and surface the proposal for admin
 * approval.
 *
 * <p>The actual emit point requires the {@code call} step kind in the
 * Job engine (the only remaining Phase 3 gap) plus the architect agent
 * itself. This event type lives here as forward-compat scaffolding so the
 * listener contract is stable when those land.
 */
public record PipelineSpecProducedEvent(
    String orgId,
    String parentJobId,
    String architectJobId,
    JsonNode pipelineSpec
) {
}

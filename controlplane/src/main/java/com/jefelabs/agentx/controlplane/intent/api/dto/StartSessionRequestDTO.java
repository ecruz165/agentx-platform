package com.jefelabs.agentx.controlplane.intent.api.dto;

import tools.jackson.databind.JsonNode;

/**
 * Wire format for {@code POST /api/intent/sessions} per
 * prd-intent-module.md F1. {@code intakePipelineId} is the catalog
 * FlowDef id of the JobDefinitionPipeline to drive the intake; if
 * omitted the service uses the configured default ({@code default-intake}).
 *
 * <p>{@code productId} scopes context loading. {@code initialInput} is
 * an optional first-message payload passed as the intake job's
 * {@code input} (the clarifier agent reads it as the opening turn).
 */
public record StartSessionRequestDTO(
    String intakePipelineId,
    String productId,
    JsonNode initialInput
) {
}

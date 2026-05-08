package com.jefelabs.agentx.controlplane.eval.api.dto;

import tools.jackson.databind.JsonNode;

/**
 * Wire format for {@code POST /api/evals/suites/{id}/run}. The flow +
 * product determine the variant under test; the label distinguishes
 * runs in compare output. {@code config} is merged into each submitted
 * job's config (the service appends its own {@code benchmark.runId} +
 * {@code benchmark.label} on top).
 */
public record RunSuiteRequestDTO(
    String flowId,
    String productId,
    String label,
    JsonNode config
) {
}

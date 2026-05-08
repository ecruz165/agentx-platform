package com.jefelabs.agentx.controlplane.eval.api.dto;

import tools.jackson.databind.JsonNode;

/**
 * Wire format for {@code POST /api/evals/suites}. {@code inputs} must be
 * a JSON array; each element becomes one job's input on run.
 */
public record UpsertSuiteRequestDTO(
    String id,
    String name,
    String description,
    JsonNode inputs
) {
}

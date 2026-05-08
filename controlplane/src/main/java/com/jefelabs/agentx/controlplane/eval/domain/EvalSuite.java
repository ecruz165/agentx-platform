package com.jefelabs.agentx.controlplane.eval.domain;

import tools.jackson.databind.JsonNode;

import java.time.Instant;

/**
 * A named bag of inputs against which a benchmark run submits one job
 * per input. {@code inputs} is a JsonNode array; each element becomes
 * one job's input field.
 */
public record EvalSuite(
    String orgId,
    String id,
    String name,
    String description,
    JsonNode inputs,
    Instant createdAt,
    Instant updatedAt,
    String createdBy
) {
}

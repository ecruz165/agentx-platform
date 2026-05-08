package com.jefelabs.agentx.controlplane.harness.api.dto;

import tools.jackson.databind.JsonNode;

/**
 * Wire format for {@code POST /api/registry/harnesses}. Per prd-harness-module.md F1:
 *   { name, version, capabilities, region, endpoints }
 * Caller-supplied {@code id} is optional; when absent the server assigns one.
 */
public record RegisterHarnessRequestDTO(
    String id,
    String name,
    String version,
    String region,
    JsonNode capabilities,
    JsonNode endpoints
) {
}

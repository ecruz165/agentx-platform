package com.jefelabs.agentx.controlplane.eval.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record RunSuiteResponseDTO(
    String runId,
    String label,
    List<String> jobIds
) {
}

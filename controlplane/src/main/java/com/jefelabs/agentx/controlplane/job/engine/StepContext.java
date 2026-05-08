package com.jefelabs.agentx.controlplane.job.engine;

import com.jefelabs.agentx.controlplane.job.domain.Job;
import tools.jackson.databind.JsonNode;

/**
 * What a step handler sees when it runs. {@link #node} is the FlowDef
 * node JSON ({@code id}, {@code kind}, {@code config}); {@link #flow}
 * is the entire FlowDef root for handlers that need to walk further
 * (Loop, Map, Fork in later phases).
 *
 * <p>{@code priorOutput} is what the previous step on this branch
 * emitted — the input for chained transforms, agent prompts, etc.
 */
public record StepContext(
    Job job,
    JsonNode flow,
    JsonNode node,
    String nodeId,
    String nodeKind,
    JsonNode priorOutput
) {
}

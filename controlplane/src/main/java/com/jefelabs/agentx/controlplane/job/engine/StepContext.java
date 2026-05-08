package com.jefelabs.agentx.controlplane.job.engine;

import com.jefelabs.agentx.controlplane.job.domain.Job;
import tools.jackson.databind.JsonNode;

/**
 * What a step handler sees when it runs. {@link #node} is the FlowDef
 * node JSON ({@code id}, {@code kind}, {@code config}); {@link #flow}
 * is the entire FlowDef root for handlers that need to walk further.
 *
 * <p>{@code priorOutput} is what the previous step on this branch
 * emitted — the input for chained transforms, agent prompts, etc.
 *
 * <p>{@code bodyRunner} is the engine collaboration point for compound
 * step kinds (Loop, Fork, Map, Call) that execute other nodes inline.
 * Simple handlers (Agent, Transform, Phase, Conditional, Succeed)
 * ignore it.
 */
public record StepContext(
    Job job,
    JsonNode flow,
    JsonNode node,
    String nodeId,
    String nodeKind,
    JsonNode priorOutput,
    BodyRunner bodyRunner
) {
}

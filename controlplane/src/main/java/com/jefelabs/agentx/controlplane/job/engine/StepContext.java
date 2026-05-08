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
 *
 * <p>{@code resumeData} is non-null only when this is a resume of a
 * paused step (Phase 3e: WaitForEvent + Approval). Handlers check for
 * non-null to distinguish first-invocation from resumption — on first
 * invocation they typically return Pause; on resume they consume the
 * resumeData (an event payload, an approval verdict) and return Advance.
 */
public record StepContext(
    Job job,
    JsonNode flow,
    JsonNode node,
    String nodeId,
    String nodeKind,
    JsonNode priorOutput,
    BodyRunner bodyRunner,
    JsonNode resumeData
) {
    /** Convenience for first-call (non-resume) construction. */
    public StepContext(
        Job job,
        JsonNode flow,
        JsonNode node,
        String nodeId,
        String nodeKind,
        JsonNode priorOutput,
        BodyRunner bodyRunner
    ) {
        this(job, flow, node, nodeId, nodeKind, priorOutput, bodyRunner, null);
    }

    /** True when this invocation is a resume of a previously-paused step. */
    public boolean isResume() {
        return resumeData != null;
    }
}

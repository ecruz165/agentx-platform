package com.jefelabs.agentx.controlplane.job.engine.handlers;

import com.jefelabs.agentx.controlplane.job.engine.StepContext;
import com.jefelabs.agentx.controlplane.job.engine.StepKindHandler;
import com.jefelabs.agentx.controlplane.job.engine.StepResult;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

/**
 * {@code kind: 'wait-for-event'} — pauses the job until an external HTTP
 * POST delivers a named event. The first invocation returns
 * {@link StepResult.Pause}; the engine writes
 * {@code job.current_node_id} and returns from runJob, leaving the job
 * in RUNNING. The resume API
 * ({@code POST /api/jobs/{id}/events/{eventName}}) re-engages the engine
 * with the delivered payload as {@link StepContext#resumeData()}; this
 * handler then returns {@code Advance(resumeData)}.
 *
 * <p>FlowDef shape:
 * <pre>{@code
 * {
 *   "id": "we1",
 *   "kind": "wait-for-event",
 *   "config": { "eventName": "user-message" }
 * }
 * }</pre>
 *
 * <p>The event name is a contract between the flow and the resume caller —
 * the resume API verifies the URL's event name matches {@code config.eventName}
 * before re-engaging.
 */
@Component
public class WaitForEventStepHandler implements StepKindHandler {

    @Override
    public String kind() {
        return "wait-for-event";
    }

    @Override
    public StepResult execute(StepContext context) {
        JsonNode config = context.node().path("config");
        String eventName = config.path("eventName").asText("");
        if (eventName.isEmpty()) {
            return new StepResult.TerminateFailure(
                "wait-for-event step '" + context.nodeId() + "' missing config.eventName");
        }

        if (context.isResume()) {
            // Engine resumed us with the delivered event payload — emit + continue.
            return new StepResult.Advance(context.resumeData());
        }

        // First invocation — pause for external delivery.
        return new StepResult.Pause("waiting for event: " + eventName);
    }
}

package com.jefelabs.agentx.controlplane.job.engine.handlers;

import com.jefelabs.agentx.controlplane.job.engine.StepContext;
import com.jefelabs.agentx.controlplane.job.engine.StepKindHandler;
import com.jefelabs.agentx.controlplane.job.engine.StepResult;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

/**
 * {@code kind: 'wait'} — blocks for {@code config.ms} then advances.
 * Thread.sleep on a virtual thread (Java 21) is essentially free — the
 * thread parks, no kernel-thread cost — so blocking for seconds-to-minutes
 * is fine. For multi-hour waits, switch to a scheduler-based pause; the
 * threshold isn't worth optimizing yet.
 *
 * <p>FlowDef shape:
 * <pre>{@code
 * { "id": "w1", "kind": "wait", "config": { "ms": 5000 } }
 * }</pre>
 */
@Component
public class WaitStepHandler implements StepKindHandler {

    @Override
    public String kind() {
        return "wait";
    }

    @Override
    public StepResult execute(StepContext context) {
        JsonNode config = context.node().path("config");
        long ms = config.path("ms").asLong(0);
        if (ms <= 0) {
            return new StepResult.TerminateFailure(
                "wait step '" + context.nodeId() + "' requires positive config.ms");
        }
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new StepResult.TerminateFailure(
                "wait step '" + context.nodeId() + "' interrupted");
        }
        return new StepResult.Advance(context.priorOutput());
    }
}

package com.jefelabs.agentx.controlplane.job.engine.handlers;

import com.jefelabs.agentx.controlplane.job.engine.StepContext;
import com.jefelabs.agentx.controlplane.job.engine.StepKindHandler;
import com.jefelabs.agentx.controlplane.job.engine.StepResult;
import org.springframework.stereotype.Component;

/**
 * {@code kind: 'fail'} — terminal failure. Marks the job FAILED with the
 * configured reason (or a default if none provided). Symmetric to
 * {@link SucceedStepHandler}.
 *
 * <p>FlowDef shape:
 * <pre>{@code
 * { "id": "f1", "kind": "fail", "config": { "reason": "input rejected" } }
 * }</pre>
 *
 * <p>Useful as the target of a Conditional's {@code rejected}/{@code else}
 * edge when business logic dictates a hard failure.
 */
@Component
public class FailStepHandler implements StepKindHandler {

    @Override
    public String kind() {
        return "fail";
    }

    @Override
    public StepResult execute(StepContext context) {
        String reason = context.node().path("config").path("reason")
            .asText("explicit fail step '" + context.nodeId() + "'");
        return new StepResult.TerminateFailure(reason);
    }
}

package com.jefelabs.agentx.controlplane.job.engine.handlers;

import com.jefelabs.agentx.controlplane.job.engine.StepContext;
import com.jefelabs.agentx.controlplane.job.engine.StepKindHandler;
import com.jefelabs.agentx.controlplane.job.engine.StepResult;
import org.springframework.stereotype.Component;

/**
 * {@code kind: 'succeed'} — terminal success. Marks the job COMPLETED.
 * The step's output is the prior step's output (or null when this is
 * the only step after the trigger).
 */
@Component
public class SucceedStepHandler implements StepKindHandler {

    @Override
    public String kind() {
        return "succeed";
    }

    @Override
    public StepResult execute(StepContext context) {
        return new StepResult.TerminateSuccess(context.priorOutput());
    }
}

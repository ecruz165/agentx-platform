package com.jefelabs.agentx.controlplane.job.engine.handlers;

import com.jefelabs.agentx.controlplane.job.engine.StepContext;
import com.jefelabs.agentx.controlplane.job.engine.StepKindHandler;
import com.jefelabs.agentx.controlplane.job.engine.StepResult;
import org.springframework.stereotype.Component;

/**
 * {@code kind: 'phase'} — semantic decorator for grouping steps in the
 * audit log + UI timeline. Pass-through: emits step-started + step-completed
 * events around itself (engine does that for every step), forwards
 * {@code priorOutput} unchanged to the next node.
 *
 * <p>The phase {@code name} from {@code node.config.name} is recorded as
 * the step's input/output JSON so the timeline view can group nested
 * children under their phase. Future {@code phase-enter} / {@code phase-exit}
 * custom event types arrive in Phase 3.x with the SSE event stream.
 */
@Component
public class PhaseStepHandler implements StepKindHandler {

    @Override
    public String kind() {
        return "phase";
    }

    @Override
    public StepResult execute(StepContext context) {
        return new StepResult.Advance(context.priorOutput());
    }
}

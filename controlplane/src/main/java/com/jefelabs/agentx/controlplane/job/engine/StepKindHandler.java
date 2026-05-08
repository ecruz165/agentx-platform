package com.jefelabs.agentx.controlplane.job.engine;

/**
 * One handler per FlowDef node kind. Spring discovers all
 * {@code @Component}-annotated impls; the engine builds a
 * {@code Map<String, StepKindHandler>} keyed on {@link #kind()}.
 *
 * <p>Adding a new step kind = adding a new {@code @Component} that
 * implements this — no engine code changes (per the umbrella-PRD
 * D-line "hand-rolled state machine engine, not a library" rationale).
 */
public interface StepKindHandler {

    /** Matches the FlowDef node's {@code kind} discriminator value. */
    String kind();

    /** Run the step against the given context; the verdict drives the engine's next move. */
    StepResult execute(StepContext context);
}

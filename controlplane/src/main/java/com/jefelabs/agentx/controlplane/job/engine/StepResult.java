package com.jefelabs.agentx.controlplane.job.engine;

import tools.jackson.databind.JsonNode;

/**
 * The verdict a {@link StepKindHandler} returns after running a node.
 * The {@link JobEngine} drives the next walk decision based on which
 * variant came back.
 */
public sealed interface StepResult {

    /** Step finished cleanly; engine follows outgoing edge(s) to the next node. */
    record Advance(JsonNode output) implements StepResult {}

    /** Step paused for an external event (Approval, Wait, WaitForEvent — Phase 3e). */
    record Pause(String reason) implements StepResult {}

    /** Terminal success — marks the whole job COMPLETED with this output. */
    record TerminateSuccess(JsonNode output) implements StepResult {}

    /** Terminal failure — marks the whole job FAILED with this reason. */
    record TerminateFailure(String reason) implements StepResult {}
}

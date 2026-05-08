package com.jefelabs.agentx.controlplane.job.engine;

import tools.jackson.databind.JsonNode;

/**
 * Engine collaboration point for compound step kinds (Loop, Fork, Map,
 * Call) that need to execute other nodes inline. The {@link JobEngine}
 * provides an instance per {@code runJob} invocation, threading the
 * job's persistence + event-emission paths through; handlers receive
 * the runner via {@link StepContext#bodyRunner()}.
 *
 * <p>Phase 3c.2 introduces this for {@link com.jefelabs.agentx.controlplane.job.engine.handlers.LoopStepHandler};
 * Phase 3c.3 reuses it for parallel branch dispatch in Fork + Map.
 *
 * <p>Each {@code runNode} invocation creates a fresh {@code job_steps}
 * row with monotonically-increasing {@code attempt} for the same node id,
 * so a loop body iteration history is observable in the audit log.
 */
public interface BodyRunner {

    /**
     * Run a single node as a child execution; returns its
     * {@link StepResult.Advance#output()}. Body steps that don't return
     * Advance (TerminateSuccess, TerminateFailure, Pause) throw a
     * {@link BodyExecutionException} the parent handler catches.
     */
    JsonNode runNode(String nodeId, JsonNode priorOutput);

    /** Thrown when a body step returns a non-Advance verdict. */
    class BodyExecutionException extends RuntimeException {
        private final StepResult result;
        private final String bodyNodeId;

        public BodyExecutionException(String bodyNodeId, StepResult result, String message) {
            super(message);
            this.bodyNodeId = bodyNodeId;
            this.result = result;
        }

        public String bodyNodeId() { return bodyNodeId; }
        public StepResult result() { return result; }
    }
}

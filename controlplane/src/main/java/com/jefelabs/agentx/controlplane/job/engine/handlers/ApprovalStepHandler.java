package com.jefelabs.agentx.controlplane.job.engine.handlers;

import com.jefelabs.agentx.controlplane.job.engine.StepContext;
import com.jefelabs.agentx.controlplane.job.engine.StepKindHandler;
import com.jefelabs.agentx.controlplane.job.engine.StepResult;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

/**
 * {@code kind: 'approval'} — pauses for human-in-the-loop verdict.
 * First invocation returns {@link StepResult.Pause}; the engine emits
 * {@code approval-required} (currently as a generic step-paused event)
 * and leaves the job in RUNNING. The resume API
 * ({@code POST /api/jobs/{id}/approvals/{nodeId}}) re-engages with
 * {@link StepContext#resumeData()} carrying {@code { verdict, reason?, approver? }}.
 *
 * <p>On resume:
 * <ul>
 *   <li>{@code verdict: 'approved'} → {@code Advance(priorOutput, "approved")}
 *       so the engine follows an outgoing edge labeled "approved".</li>
 *   <li>{@code verdict: 'rejected'} → {@code Advance(priorOutput, "rejected")}
 *       so the engine follows an outgoing edge labeled "rejected".</li>
 *   <li>Anything else → {@code TerminateFailure}.</li>
 * </ul>
 *
 * <p>FlowDef shape (typical):
 * <pre>{@code
 * {
 *   "id": "ap1",
 *   "kind": "approval",
 *   "config": { "prompt": "Approve this PR?", "approverRole": "catalog-admin" }
 * }
 * }</pre>
 *
 * <p>{@code config.timeoutMs} is reserved for Phase 3e.x (auto-reject after deadline).
 */
@Component
public class ApprovalStepHandler implements StepKindHandler {

    @Override
    public String kind() {
        return "approval";
    }

    @Override
    public StepResult execute(StepContext context) {
        if (!context.isResume()) {
            String prompt = context.node().path("config").path("prompt").asText("approval required");
            return new StepResult.Pause("approval required: " + prompt);
        }

        JsonNode resume = context.resumeData();
        String verdict = resume.path("verdict").asText("");
        return switch (verdict) {
            case "approved" -> new StepResult.Advance(context.priorOutput(), "approved");
            case "rejected" -> new StepResult.Advance(context.priorOutput(), "rejected");
            default -> new StepResult.TerminateFailure(
                "approval step '" + context.nodeId() + "' received invalid verdict: '" + verdict +
                "' (expected 'approved' or 'rejected')");
        };
    }
}

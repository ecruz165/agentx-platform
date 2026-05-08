package com.jefelabs.agentx.controlplane.job.engine.handlers;

import com.jefelabs.agentx.controlplane.job.engine.BodyRunner;
import com.jefelabs.agentx.controlplane.job.engine.StepContext;
import com.jefelabs.agentx.controlplane.job.engine.StepKindHandler;
import com.jefelabs.agentx.controlplane.job.engine.StepResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * {@code kind: 'try'} — runs body; on TerminateFailure, runs the catch
 * body with the failure reason as input. The catch body's output becomes
 * the try step's output. TerminateSuccess + Pause propagate immediately.
 *
 * <p>FlowDef shape:
 * <pre>{@code
 * {
 *   "id": "t1",
 *   "kind": "try",
 *   "config": {
 *     "body":  "<bodyNodeId>",      // primary path
 *     "catch": "<catchNodeId>"      // failure path; receives { reason, originalInput }
 *   }
 * }
 * }</pre>
 *
 * <p>Phase 3d's catch body is a single node (same constraint as Loop /
 * Fork branches / Map body). Multi-step catch chains land when sub-graph
 * execution arrives.
 */
@Component
public class TryStepHandler implements StepKindHandler {

    private static final Logger log = LoggerFactory.getLogger(TryStepHandler.class);

    private final ObjectMapper objectMapper;

    public TryStepHandler(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public String kind() {
        return "try";
    }

    @Override
    public StepResult execute(StepContext context) {
        JsonNode config = context.node().path("config");
        String bodyNodeId = config.path("body").asText();
        String catchNodeId = config.path("catch").asText();
        if (bodyNodeId.isEmpty() || catchNodeId.isEmpty()) {
            return new StepResult.TerminateFailure(
                "try step '" + context.nodeId() + "' requires config.body and config.catch");
        }

        try {
            JsonNode output = context.bodyRunner().runNode(bodyNodeId, context.priorOutput());
            return new StepResult.Advance(output);
        } catch (BodyRunner.BodyExecutionException e) {
            // TerminateSuccess + Pause propagate; only TerminateFailure triggers catch
            if (!(e.result() instanceof StepResult.TerminateFailure failure)) {
                return switch (e.result()) {
                    case StepResult.TerminateSuccess success -> success;
                    case StepResult.Pause pause -> pause;
                    default -> new StepResult.TerminateFailure(
                        "try body returned unexpected: " + e.getMessage());
                };
            }

            log.info("Job {} try step '{}' body '{}' failed; running catch '{}'",
                context.job().id(), context.nodeId(), bodyNodeId, catchNodeId);

            // Build catch input: { reason, originalInput }
            ObjectNode catchInput = objectMapper.createObjectNode();
            catchInput.put("reason", failure.reason());
            catchInput.set("originalInput",
                context.priorOutput() != null ? context.priorOutput() : objectMapper.nullNode());

            try {
                JsonNode catchOutput = context.bodyRunner().runNode(catchNodeId, catchInput);
                return new StepResult.Advance(catchOutput);
            } catch (BodyRunner.BodyExecutionException ce) {
                // Catch itself failed — propagate
                return switch (ce.result()) {
                    case StepResult.TerminateSuccess success -> success;
                    case StepResult.TerminateFailure cf ->
                        new StepResult.TerminateFailure(
                            "try step '" + context.nodeId() + "' catch '" + catchNodeId +
                            "' also failed: " + cf.reason());
                    case StepResult.Pause pause -> pause;
                    default -> new StepResult.TerminateFailure(
                        "try catch returned unexpected: " + ce.getMessage());
                };
            }
        }
    }
}

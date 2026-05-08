package com.jefelabs.agentx.controlplane.job.engine.handlers;

import com.jefelabs.agentx.controlplane.job.engine.BodyRunner;
import com.jefelabs.agentx.controlplane.job.engine.StepContext;
import com.jefelabs.agentx.controlplane.job.engine.StepKindHandler;
import com.jefelabs.agentx.controlplane.job.engine.StepResult;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * {@code kind: 'timeout'} — runs body with a wall-clock deadline. On
 * timeout, follows the configured onTimeout policy ({@code fail} default).
 * Body executes on a virtual thread per call so the parent thread's
 * Future.get(timeout) can interrupt it cleanly.
 *
 * <p>FlowDef shape:
 * <pre>{@code
 * {
 *   "id": "to1",
 *   "kind": "timeout",
 *   "config": {
 *     "body": "<bodyNodeId>",
 *     "ms": 30000,                       // deadline; required
 *     "onTimeout": { "kind": "fail" }    // optional; default 'fail'
 *   }
 * }
 * }</pre>
 *
 * <p>Phase 3d supports {@code onTimeout.kind = 'fail'} only. Other
 * policies ({@code 'continue'}, {@code 'fallback'} pointing at another
 * node) arrive when the use cases surface.
 */
@Component
public class TimeoutStepHandler implements StepKindHandler {

    @Override
    public String kind() {
        return "timeout";
    }

    @Override
    public StepResult execute(StepContext context) {
        JsonNode config = context.node().path("config");
        String bodyNodeId = config.path("body").asText();
        if (bodyNodeId.isEmpty()) {
            return new StepResult.TerminateFailure(
                "timeout step '" + context.nodeId() + "' missing config.body");
        }

        long deadlineMs = config.path("ms").asLong(0);
        if (deadlineMs <= 0) {
            return new StepResult.TerminateFailure(
                "timeout step '" + context.nodeId() + "' requires positive config.ms");
        }

        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            Future<JsonNode> future = executor.submit(() ->
                context.bodyRunner().runNode(bodyNodeId, context.priorOutput()));

            JsonNode output;
            try {
                output = future.get(deadlineMs, TimeUnit.MILLISECONDS);
            } catch (TimeoutException te) {
                future.cancel(true);
                return new StepResult.TerminateFailure(
                    "timeout step '" + context.nodeId() + "' exceeded " + deadlineMs + "ms");
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                future.cancel(true);
                return new StepResult.TerminateFailure(
                    "timeout step '" + context.nodeId() + "' interrupted");
            } catch (ExecutionException ee) {
                Throwable cause = ee.getCause() != null ? ee.getCause() : ee;
                if (cause instanceof BodyRunner.BodyExecutionException be) {
                    // Body returned a non-Advance verdict — propagate it
                    return switch (be.result()) {
                        case StepResult.TerminateSuccess success -> success;
                        case StepResult.TerminateFailure failure -> failure;
                        case StepResult.Pause pause -> pause;
                        default -> new StepResult.TerminateFailure(
                            "timeout body returned unexpected: " + be.getMessage());
                    };
                }
                return new StepResult.TerminateFailure(
                    "timeout step '" + context.nodeId() + "' body threw: " + cause.getMessage());
            }

            return new StepResult.Advance(output);
        }
    }
}

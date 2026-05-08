package com.jefelabs.agentx.controlplane.job.engine.handlers;

import com.jefelabs.agentx.controlplane.job.engine.BodyRunner;
import com.jefelabs.agentx.controlplane.job.engine.StepContext;
import com.jefelabs.agentx.controlplane.job.engine.StepKindHandler;
import com.jefelabs.agentx.controlplane.job.engine.StepResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

/**
 * {@code kind: 'retry'} — runs body; on TerminateFailure, retries with
 * configurable backoff up to {@code maxAttempts} total. Other body
 * verdicts (TerminateSuccess, Pause) propagate immediately.
 *
 * <p>FlowDef shape:
 * <pre>{@code
 * {
 *   "id": "r1",
 *   "kind": "retry",
 *   "config": {
 *     "body": "<bodyNodeId>",
 *     "maxAttempts": 3,                  // optional; default 3
 *     "backoff": { "kind": "fixed", "ms": 100 }     // optional; default fixed 0ms
 *     // or { "kind": "exponential", "initialMs": 100, "factor": 2, "maxMs": 5000 }
 *   }
 * }
 * }</pre>
 *
 * <p>Each retry creates a fresh {@code job_steps} row on the body node
 * via BodyRunner's monotonic attempt counter — the audit log shows exactly
 * how many tries ran + which ones failed.
 */
@Component
public class RetryStepHandler implements StepKindHandler {

    private static final Logger log = LoggerFactory.getLogger(RetryStepHandler.class);
    private static final int DEFAULT_MAX_ATTEMPTS = 3;

    @Override
    public String kind() {
        return "retry";
    }

    @Override
    public StepResult execute(StepContext context) {
        JsonNode config = context.node().path("config");
        String bodyNodeId = config.path("body").asText();
        if (bodyNodeId.isEmpty()) {
            return new StepResult.TerminateFailure(
                "retry step '" + context.nodeId() + "' missing config.body");
        }

        int maxAttempts = Math.max(1, config.path("maxAttempts").asInt(DEFAULT_MAX_ATTEMPTS));
        JsonNode backoff = config.path("backoff");

        String lastFailureReason = null;
        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                JsonNode output = context.bodyRunner().runNode(bodyNodeId, context.priorOutput());
                if (attempt > 1) {
                    log.info("Job {} retry step '{}' body '{}' succeeded on attempt {}",
                        context.job().id(), context.nodeId(), bodyNodeId, attempt);
                }
                return new StepResult.Advance(output);
            } catch (BodyRunner.BodyExecutionException e) {
                // TerminateFailure → retry; TerminateSuccess / Pause → propagate
                if (e.result() instanceof StepResult.TerminateFailure failure) {
                    lastFailureReason = failure.reason();
                    if (attempt < maxAttempts) {
                        long delayMs = computeBackoff(backoff, attempt);
                        if (delayMs > 0) {
                            try {
                                Thread.sleep(delayMs);
                            } catch (InterruptedException ie) {
                                Thread.currentThread().interrupt();
                                return new StepResult.TerminateFailure(
                                    "retry step '" + context.nodeId() + "' interrupted during backoff");
                            }
                        }
                    }
                } else {
                    // Body returned TerminateSuccess or Pause — propagate the same shape
                    return switch (e.result()) {
                        case StepResult.TerminateSuccess success -> success;
                        case StepResult.Pause pause -> pause;
                        default -> new StepResult.TerminateFailure(
                            "retry body returned unexpected result: " + e.getMessage());
                    };
                }
            }
        }

        return new StepResult.TerminateFailure(
            "retry step '" + context.nodeId() + "' exhausted " + maxAttempts +
            " attempts; last failure: " + lastFailureReason);
    }

    private long computeBackoff(JsonNode backoff, int attemptJustCompleted) {
        String kind = backoff.path("kind").asText("fixed");
        return switch (kind) {
            case "fixed" -> backoff.path("ms").asLong(0);
            case "exponential" -> {
                long initial = backoff.path("initialMs").asLong(100);
                long max = backoff.path("maxMs").asLong(5000);
                double factor = backoff.path("factor").asDouble(2.0);
                long delay = (long) (initial * Math.pow(factor, attemptJustCompleted - 1));
                yield Math.min(delay, max);
            }
            default -> 0L;
        };
    }
}

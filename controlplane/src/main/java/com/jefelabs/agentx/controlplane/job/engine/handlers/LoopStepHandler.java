package com.jefelabs.agentx.controlplane.job.engine.handlers;

import com.jefelabs.agentx.controlplane.job.engine.BodyRunner;
import com.jefelabs.agentx.controlplane.job.engine.StepContext;
import com.jefelabs.agentx.controlplane.job.engine.StepKindHandler;
import com.jefelabs.agentx.controlplane.job.engine.StepResult;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * {@code kind: 'loop'} — runs a body node repeatedly, threading each
 * iteration's output as the next iteration's input, until either the
 * {@code until} condition matches or {@code maxIterations} is reached.
 *
 * <p>FlowDef shape:
 * <pre>{@code
 * {
 *   "id": "myloop",
 *   "kind": "loop",
 *   "config": {
 *     "body": "<bodyNodeId>",                  // single body node id (Phase 3c.2)
 *     "until": { "kind": "...", ... },         // exit predicate
 *     "maxIterations": 5                        // hard cap; default 10
 *   }
 * }
 * }</pre>
 *
 * <p>Phase 3c.2 supports the simplest two {@code until} kinds (matching
 * {@code prd-job-module.md} §6.3a's {@code LoopCondition} taxonomy):
 * <ul>
 *   <li>{@code iteration-limit} — never matches; loop runs to maxIterations.</li>
 *   <li>{@code output-matches} — Java regex on the textual representation of
 *       the latest iteration's body output.</li>
 * </ul>
 *
 * <p>Multi-step bodies, structured-output / intent-ready / agent-signal
 * conditions, and {@code conditionEval: 'after-each-step'} arrive in
 * later sub-phases. The body executes via {@link BodyRunner}; each
 * iteration creates a fresh {@code job_steps} row with
 * {@code attempt = iteration} on the body node.
 */
@Component
public class LoopStepHandler implements StepKindHandler {

    private static final int DEFAULT_MAX_ITERATIONS = 10;

    @Override
    public String kind() {
        return "loop";
    }

    @Override
    public StepResult execute(StepContext context) {
        JsonNode config = context.node().path("config");
        String bodyNodeId = config.path("body").asText();
        if (bodyNodeId.isEmpty()) {
            return new StepResult.TerminateFailure(
                "loop step '" + context.nodeId() + "' missing config.body");
        }

        int maxIterations = Math.max(1, config.path("maxIterations").asInt(DEFAULT_MAX_ITERATIONS));
        JsonNode untilCondition = config.path("until");

        JsonNode currentOutput = context.priorOutput();
        try {
            for (int iteration = 1; iteration <= maxIterations; iteration++) {
                currentOutput = context.bodyRunner().runNode(bodyNodeId, currentOutput);
                if (conditionMet(untilCondition, currentOutput, iteration)) {
                    break;
                }
            }
        } catch (BodyRunner.BodyExecutionException e) {
            // Body returned TerminateSuccess / TerminateFailure / Pause — propagate
            // by terminating the loop with the same shape (Phase 3c.2 keeps it simple;
            // Phase 3.x can add per-loop catch / continue semantics).
            return switch (e.result()) {
                case StepResult.TerminateSuccess success -> success;
                case StepResult.TerminateFailure failure -> failure;
                case StepResult.Pause pause -> pause;
                default -> new StepResult.TerminateFailure(
                    "loop body '" + e.bodyNodeId() + "' threw: " + e.getMessage());
            };
        }

        return new StepResult.Advance(currentOutput);
    }

    private boolean conditionMet(JsonNode untilCondition, JsonNode latestOutput, int iteration) {
        String kind = untilCondition.path("kind").asText("");
        return switch (kind) {
            case "", "iteration-limit" -> false;  // loop runs to maxIterations
            case "output-matches" -> {
                String pattern = untilCondition.path("pattern").asText();
                if (pattern.isEmpty()) {
                    throw new IllegalArgumentException("output-matches requires non-empty 'pattern'");
                }
                String text;
                if (latestOutput == null) {
                    text = "";
                } else if (latestOutput.isTextual()) {
                    text = latestOutput.asText();
                } else {
                    text = latestOutput.toString();
                }
                try {
                    yield Pattern.compile(pattern).matcher(text).find();
                } catch (PatternSyntaxException e) {
                    throw new IllegalArgumentException("invalid regex: " + pattern, e);
                }
            }
            default -> throw new IllegalArgumentException(
                "unknown loop until kind: " + kind +
                " (Phase 3c.2 supports iteration-limit, output-matches)");
        };
    }
}

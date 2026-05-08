package com.jefelabs.agentx.controlplane.job.engine.handlers;

import com.jefelabs.agentx.controlplane.job.engine.StepContext;
import com.jefelabs.agentx.controlplane.job.engine.StepKindHandler;
import com.jefelabs.agentx.controlplane.job.engine.StepResult;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * {@code kind: 'conditional'} — evaluates a predicate against {@code priorOutput}
 * and returns {@code Advance(priorOutput, "then" | "else")}. The engine then
 * follows the outgoing edge whose {@code label} matches.
 *
 * <p>Phase 3c.1 supports two predicate kinds (the simplest from
 * {@code prd-job-module.md} §6.3a's {@code Predicate} taxonomy):
 * <ul>
 *   <li>{@code output-equals} — {@code value} field; deep-equals on JsonNode.</li>
 *   <li>{@code output-matches} — {@code pattern} field; Java regex against
 *       the textual representation of {@code priorOutput}.</li>
 * </ul>
 *
 * <p>Catalog-aware predicates ({@code no-pipeline-matches},
 * {@code pipeline-exists}, {@code intent-ambiguous}) require Catalog
 * lookups and arrive with the validator + IntentService work in later phases.
 */
@Component
public class ConditionalStepHandler implements StepKindHandler {

    @Override
    public String kind() {
        return "conditional";
    }

    @Override
    public StepResult execute(StepContext context) {
        JsonNode predicate = context.node().path("config").path("predicate");
        String predicateKind = predicate.path("kind").asText("");
        if (predicateKind.isEmpty()) {
            return new StepResult.TerminateFailure(
                "conditional step '" + context.nodeId() + "' missing config.predicate.kind");
        }

        boolean matches;
        try {
            matches = evaluate(predicateKind, predicate, context.priorOutput());
        } catch (RuntimeException e) {
            return new StepResult.TerminateFailure(
                "conditional step '" + context.nodeId() + "' predicate '" + predicateKind +
                "' threw: " + e.getMessage());
        }

        return new StepResult.Advance(context.priorOutput(), matches ? "then" : "else");
    }

    private boolean evaluate(String predicateKind, JsonNode predicate, JsonNode prior) {
        return switch (predicateKind) {
            case "output-equals" -> {
                JsonNode expected = predicate.path("value");
                yield expected.equals(prior);
            }
            case "output-matches" -> {
                String pattern = predicate.path("pattern").asText();
                if (pattern.isEmpty()) {
                    throw new IllegalArgumentException("output-matches requires non-empty 'pattern'");
                }
                String text = prior != null ? prior.toString() : "";
                try {
                    yield Pattern.compile(pattern).matcher(text).find();
                } catch (PatternSyntaxException e) {
                    throw new IllegalArgumentException("invalid regex: " + pattern, e);
                }
            }
            default -> throw new IllegalArgumentException(
                "unknown predicate kind: " + predicateKind +
                " (Phase 3c.1 supports output-equals, output-matches)");
        };
    }
}

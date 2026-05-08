package com.jefelabs.agentx.controlplane.job.engine.handlers;

import com.jefelabs.agentx.controlplane.job.engine.StepContext;
import com.jefelabs.agentx.controlplane.job.engine.StepKindHandler;
import com.jefelabs.agentx.controlplane.job.engine.StepResult;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * {@code kind: 'fork'} — dispatches multiple branches in parallel, joins
 * per strategy, aggregates outputs per strategy, returns the aggregate.
 *
 * <p>FlowDef shape (Phase 3c.3 supports the {@code all} + {@code array}
 * defaults; the rest of the {@code JoinStrategy} / {@code AggregateStrategy}
 * taxonomy from {@code prd-job-module.md} §6.3a arrives in 3c.3.x):
 * <pre>{@code
 * {
 *   "id": "f1",
 *   "kind": "fork",
 *   "config": {
 *     "branches": ["b1", "b2", "b3"],          // single-node body ids
 *     "join":      { "kind": "all" },           // optional; default 'all'
 *     "aggregate": { "kind": "array" }          // optional; default 'array'
 *   }
 * }
 * }</pre>
 *
 * <p>Branches execute on virtual threads — Java 21's
 * {@link Executors#newVirtualThreadPerTaskExecutor()} costs ~zero per
 * branch (parking, not kernel-thread allocation), so a fork with 50
 * branches uses 50 virtual threads with the memory of ~50 records.
 *
 * <p>Phase 3c.3 supports aggregates {@code array} (default), {@code concat},
 * {@code merge-objects}. {@code vote}, {@code pick-best}, {@code agent}
 * arrive when the LLM-orchestrated aggregations land (or per-product demand).
 */
@Component
public class ForkStepHandler implements StepKindHandler {

    private final ObjectMapper objectMapper;

    public ForkStepHandler(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public String kind() {
        return "fork";
    }

    @Override
    public StepResult execute(StepContext context) {
        JsonNode config = context.node().path("config");
        JsonNode branchesNode = config.path("branches");
        if (!branchesNode.isArray() || branchesNode.isEmpty()) {
            return new StepResult.TerminateFailure(
                "fork step '" + context.nodeId() + "' missing config.branches (array of node ids)");
        }

        List<String> branches = new ArrayList<>(branchesNode.size());
        for (JsonNode b : branchesNode) {
            branches.add(b.asText());
        }

        // Phase 3c.3 default join: 'all' (any branch failure = fork failure).
        // Aggregate handled below per the configured strategy.
        List<JsonNode> outputs;
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Future<JsonNode>> futures = new ArrayList<>(branches.size());
            JsonNode prior = context.priorOutput();
            for (String branchId : branches) {
                futures.add(executor.submit(() -> context.bodyRunner().runNode(branchId, prior)));
            }
            outputs = new ArrayList<>(branches.size());
            for (Future<JsonNode> f : futures) {
                outputs.add(f.get());
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new StepResult.TerminateFailure(
                "fork step '" + context.nodeId() + "' interrupted: " + e.getMessage());
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            return new StepResult.TerminateFailure(
                "fork step '" + context.nodeId() + "' branch failed: " + cause.getMessage());
        }

        JsonNode aggregated;
        try {
            aggregated = aggregate(config.path("aggregate"), outputs);
        } catch (RuntimeException e) {
            return new StepResult.TerminateFailure(
                "fork step '" + context.nodeId() + "' aggregate failed: " + e.getMessage());
        }
        return new StepResult.Advance(aggregated);
    }

    private JsonNode aggregate(JsonNode aggregateConfig, List<JsonNode> outputs) {
        String kind = aggregateConfig.path("kind").asText("array");
        return switch (kind) {
            case "array" -> {
                ArrayNode arr = objectMapper.createArrayNode();
                outputs.forEach(o -> arr.add(o != null ? o : objectMapper.nullNode()));
                yield arr;
            }
            case "concat" -> {
                String separator = aggregateConfig.path("separator").asText("");
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < outputs.size(); i++) {
                    if (i > 0) sb.append(separator);
                    JsonNode o = outputs.get(i);
                    if (o == null) continue;
                    sb.append(o.isTextual() ? o.asText() : o.toString());
                }
                yield objectMapper.getNodeFactory().textNode(sb.toString());
            }
            case "merge-objects" -> {
                ObjectNode merged = objectMapper.createObjectNode();
                for (JsonNode o : outputs) {
                    if (o != null && o.isObject()) merged.setAll((ObjectNode) o);
                }
                yield merged;
            }
            default -> throw new IllegalArgumentException(
                "unknown aggregate kind: " + kind +
                " (Phase 3c.3 supports array, concat, merge-objects)");
        };
    }
}

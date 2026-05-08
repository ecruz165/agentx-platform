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
 * {@code kind: 'map'} — runs a single body node once per item in a
 * collection, in parallel via virtual threads, joins per strategy,
 * aggregates per strategy.
 *
 * <p>FlowDef shape:
 * <pre>{@code
 * {
 *   "id": "m1",
 *   "kind": "map",
 *   "config": {
 *     "body": "<bodyNodeId>",
 *     "over": { "kind": "from-input", "field": "items" },  // or 'static'
 *     "join":      { "kind": "all" },
 *     "aggregate": { "kind": "array" }
 *   }
 * }
 * }</pre>
 *
 * <p>Phase 3c.3 supports two {@code over} kinds (matching
 * {@code prd-job-module.md} §6.3a's {@code MapSource}):
 * <ul>
 *   <li>{@code from-input}: pull array from {@code priorOutput.<field>}.</li>
 *   <li>{@code static}: fixed list in {@code config.over.items}.</li>
 * </ul>
 *
 * <p>{@code from-product-repos} + {@code from-step-output} arrive when the
 * Job module gains step-output addressing (Phase 3.x).
 *
 * <p>Aggregate semantics match {@link ForkStepHandler}: {@code array}
 * (default), {@code concat}, {@code merge-objects}.
 */
@Component
public class MapStepHandler implements StepKindHandler {

    private final ObjectMapper objectMapper;

    public MapStepHandler(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public String kind() {
        return "map";
    }

    @Override
    public StepResult execute(StepContext context) {
        JsonNode config = context.node().path("config");
        String bodyNodeId = config.path("body").asText();
        if (bodyNodeId.isEmpty()) {
            return new StepResult.TerminateFailure(
                "map step '" + context.nodeId() + "' missing config.body");
        }

        List<JsonNode> items;
        try {
            items = resolveItems(config.path("over"), context.priorOutput());
        } catch (RuntimeException e) {
            return new StepResult.TerminateFailure(
                "map step '" + context.nodeId() + "' over-source failed: " + e.getMessage());
        }
        if (items.isEmpty()) {
            // Empty collection → empty aggregate
            return new StepResult.Advance(aggregate(config.path("aggregate"), List.of()));
        }

        List<JsonNode> outputs;
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Future<JsonNode>> futures = new ArrayList<>(items.size());
            for (JsonNode item : items) {
                futures.add(executor.submit(() -> context.bodyRunner().runNode(bodyNodeId, item)));
            }
            outputs = new ArrayList<>(items.size());
            for (Future<JsonNode> f : futures) {
                outputs.add(f.get());
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new StepResult.TerminateFailure(
                "map step '" + context.nodeId() + "' interrupted: " + e.getMessage());
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            return new StepResult.TerminateFailure(
                "map step '" + context.nodeId() + "' iteration failed: " + cause.getMessage());
        }

        JsonNode aggregated;
        try {
            aggregated = aggregate(config.path("aggregate"), outputs);
        } catch (RuntimeException e) {
            return new StepResult.TerminateFailure(
                "map step '" + context.nodeId() + "' aggregate failed: " + e.getMessage());
        }
        return new StepResult.Advance(aggregated);
    }

    // ── helpers ───────────────────────────────────────────────────────────

    private List<JsonNode> resolveItems(JsonNode over, JsonNode priorOutput) {
        String kind = over.path("kind").asText("");
        return switch (kind) {
            case "from-input" -> {
                String field = over.path("field").asText();
                JsonNode source = field.isEmpty() ? priorOutput : (priorOutput != null ? priorOutput.path(field) : null);
                if (source == null || !source.isArray()) {
                    throw new IllegalArgumentException(
                        "from-input requires priorOutput" +
                        (field.isEmpty() ? "" : "." + field) + " to be an array");
                }
                List<JsonNode> list = new ArrayList<>(source.size());
                source.forEach(list::add);
                yield list;
            }
            case "static" -> {
                JsonNode itemsNode = over.path("items");
                if (!itemsNode.isArray()) {
                    throw new IllegalArgumentException("static requires config.over.items array");
                }
                List<JsonNode> list = new ArrayList<>(itemsNode.size());
                itemsNode.forEach(list::add);
                yield list;
            }
            default -> throw new IllegalArgumentException(
                "unknown over kind: " + kind +
                " (Phase 3c.3 supports from-input, static)");
        };
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

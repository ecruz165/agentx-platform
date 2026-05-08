package com.jefelabs.agentx.controlplane.job.engine.handlers;

import com.jefelabs.agentx.controlplane.job.engine.StepContext;
import com.jefelabs.agentx.controlplane.job.engine.StepKindHandler;
import com.jefelabs.agentx.controlplane.job.engine.StepResult;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * {@code kind: 'transform'} — pure compute step, no harness dispatch. Phase 3b.2
 * MVP supports two trivial transforms via {@code node.config}:
 * <ul>
 *   <li>{@code "passthrough": true} — output equals priorOutput.</li>
 *   <li>{@code "wrap": "<key>"} — output is {@code { "<key>": priorOutput }}.</li>
 * </ul>
 *
 * <p>Real expression evaluation (JSON path, JQ-style operations, computed
 * fields) lands in Phase 3.x. The harness-core TS side has a richer
 * transform set; this is the minimum to validate engine ↔ handler wiring
 * for non-dispatch steps.
 */
@Component
public class TransformStepHandler implements StepKindHandler {

    private final ObjectMapper objectMapper;

    public TransformStepHandler(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public String kind() {
        return "transform";
    }

    @Override
    public StepResult execute(StepContext context) {
        JsonNode config = context.node().path("config");
        JsonNode prior = context.priorOutput();

        // 'wrap' takes priority — emits { "<key>": priorOutput }
        String wrapKey = config.path("wrap").asText(null);
        if (wrapKey != null && !wrapKey.isEmpty()) {
            ObjectNode wrapped = objectMapper.createObjectNode();
            wrapped.set(wrapKey, prior != null ? prior : objectMapper.nullNode());
            return new StepResult.Advance(wrapped);
        }

        // Default + explicit passthrough: emit priorOutput unchanged.
        return new StepResult.Advance(prior);
    }
}

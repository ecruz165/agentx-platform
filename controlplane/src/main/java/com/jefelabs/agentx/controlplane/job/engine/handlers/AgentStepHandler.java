package com.jefelabs.agentx.controlplane.job.engine.handlers;

import com.jefelabs.agentx.controlplane.dispatch.domain.RoutingDecision;
import com.jefelabs.agentx.controlplane.dispatch.domain.StepContext;
import com.jefelabs.agentx.controlplane.dispatch.service.HarnessRouter;
import com.jefelabs.agentx.controlplane.job.engine.StepKindHandler;
import com.jefelabs.agentx.controlplane.job.engine.StepResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.util.List;

/**
 * {@code kind: 'agent'} — first cross-module dispatch from job → dispatch.
 * Phase 3b.2 MVP:
 * <ul>
 *   <li>Reads {@code node.config.agent.id} (the agent slug from catalog).</li>
 *   <li>Calls {@link HarnessRouter#routeStep} to pick a harness for this step.</li>
 *   <li>Mocks execution by returning a synthesized output that records
 *       which agent was supposed to run + which harness was assigned +
 *       the input that would have been sent.</li>
 *   <li>If no eligible harness → {@code TerminateFailure}.</li>
 * </ul>
 *
 * <p>Real harness RPC — sending the agent invocation across the wire +
 * receiving the response — lands once {@code harness-server} (the TS data
 * plane) speaks the protocol. Until then this handler proves the routing
 * + cross-module path; the actual execution is stubbed.
 */
@Component
public class AgentStepHandler implements StepKindHandler {

    private static final Logger log = LoggerFactory.getLogger(AgentStepHandler.class);

    private final HarnessRouter harnessRouter;
    private final ObjectMapper objectMapper;

    public AgentStepHandler(HarnessRouter harnessRouter, ObjectMapper objectMapper) {
        this.harnessRouter = harnessRouter;
        this.objectMapper = objectMapper;
    }

    @Override
    public String kind() {
        return "agent";
    }

    @Override
    public StepResult execute(com.jefelabs.agentx.controlplane.job.engine.StepContext context) {
        JsonNode config = context.node().path("config");
        String agentId = config.path("agent").path("id").asText("");
        if (agentId.isEmpty()) {
            return new StepResult.TerminateFailure(
                "agent step '" + context.nodeId() + "' missing config.agent.id");
        }

        StepContext routeCtx = new StepContext(
            context.job().orgId(),
            context.job().id(),
            context.nodeId(),
            context.job().productId(),
            List.of(),  // capability filtering arrives in dispatch Phase 2.x
            StepContext.AffinityHint.NONE
        );
        RoutingDecision decision = harnessRouter.routeStep(routeCtx);

        return switch (decision) {
            case RoutingDecision.Routed routed -> {
                log.info("Job {} step {} agent {} → harness {}",
                    context.job().id(), context.nodeId(), agentId, routed.harnessId());

                // Phase 3b.2: mock execution. Real RPC to harness-server lands later.
                ObjectNode output = objectMapper.createObjectNode();
                output.put("agent", agentId);
                output.put("harnessId", routed.harnessId());
                output.put("policy", routed.policyUsed());
                output.set("input", context.priorOutput() != null
                    ? context.priorOutput() : objectMapper.nullNode());
                output.put("mockExecution", true);

                yield new StepResult.Advance(output);
            }
            case RoutingDecision.NoEligibleHarness none ->
                new StepResult.TerminateFailure(
                    "no eligible harness for agent step '" + context.nodeId() + "': " + none.reason());
        };
    }
}

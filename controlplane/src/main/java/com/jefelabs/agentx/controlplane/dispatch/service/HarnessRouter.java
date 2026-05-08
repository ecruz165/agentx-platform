package com.jefelabs.agentx.controlplane.dispatch.service;

import com.jefelabs.agentx.controlplane.dispatch.domain.RoutingDecision;
import com.jefelabs.agentx.controlplane.dispatch.domain.StepContext;
import com.jefelabs.agentx.controlplane.dispatch.policy.RoutingPolicy;
import com.jefelabs.agentx.controlplane.harness.domain.Harness;
import com.jefelabs.agentx.controlplane.harness.domain.HarnessStatus;
import com.jefelabs.agentx.controlplane.harness.service.HarnessService;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * Phase 2 MVP scheduling/policy layer per prd-dispatch-module.md.
 * Filters {@link HarnessService}'s active set to those still
 * registered/active, applies a {@link RoutingPolicy}, returns a decision.
 *
 * <p>Deferred to Phase 2.x:
 * <ul>
 *   <li>Capability filtering (currently passes through).</li>
 *   <li>Sticky affinity (StepContext exposes the hint; ignored here).</li>
 *   <li>Persisted dispatch_queue + dispatch-ready events (PRD §6.6).</li>
 *   <li>Audit log of every decision (PRD §6.5).</li>
 * </ul>
 */
@Service
public class HarnessRouter {

    private static final int LOOKUP_LIMIT = 200;

    private final HarnessService harnessService;
    private final RoutingPolicy policy;

    public HarnessRouter(HarnessService harnessService, RoutingPolicy policy) {
        this.harnessService = harnessService;
        this.policy = policy;
    }

    public RoutingDecision routeStep(StepContext context) {
        List<Harness> eligible = harnessService.listActiveByOrg(context.orgId(), LOOKUP_LIMIT, 0)
            .stream()
            .filter(h -> h.status() == HarnessStatus.REGISTERED || h.status() == HarnessStatus.ACTIVE)
            .toList();

        if (eligible.isEmpty()) {
            return new RoutingDecision.NoEligibleHarness(
                "no registered or active harnesses for org " + context.orgId()
            );
        }

        return policy.select(eligible, context)
            .<RoutingDecision>map(h -> new RoutingDecision.Routed(h.id(), policy.name(), eligible.size()))
            .orElseGet(() -> new RoutingDecision.NoEligibleHarness("policy returned empty"));
    }
}

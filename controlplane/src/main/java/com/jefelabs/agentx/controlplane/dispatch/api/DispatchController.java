package com.jefelabs.agentx.controlplane.dispatch.api;

import com.jefelabs.agentx.controlplane.core.tenancy.TenantContext;
import com.jefelabs.agentx.controlplane.dispatch.api.dto.RouteStepRequestDTO;
import com.jefelabs.agentx.controlplane.dispatch.api.dto.RouteStepResponseDTO;
import com.jefelabs.agentx.controlplane.dispatch.domain.RoutingDecision;
import com.jefelabs.agentx.controlplane.dispatch.domain.StepContext;
import com.jefelabs.agentx.controlplane.dispatch.service.HarnessRouter;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/**
 * Debug/test surface for {@link HarnessRouter}. Production callers (the Job
 * module at Phase 3) invoke {@code HarnessRouter.routeStep} via Spring DI;
 * this endpoint exists so operators + tests can probe routing behavior
 * without standing up a full job pipeline.
 */
@RestController
@RequestMapping("/api/dispatch")
public class DispatchController {

    private final HarnessRouter router;

    public DispatchController(HarnessRouter router) {
        this.router = router;
    }

    @PostMapping("/route")
    public ResponseEntity<RouteStepResponseDTO> route(@RequestBody RouteStepRequestDTO body) {
        var tenant = TenantContext.current();
        var ctx = new StepContext(
            tenant.orgId(),
            body.jobId(),
            body.stepId(),
            body.productId(),
            body.requiredCapabilities(),
            body.affinityHint() != null ? body.affinityHint() : StepContext.AffinityHint.NONE
        );

        var decision = router.routeStep(ctx);
        var response = switch (decision) {
            case RoutingDecision.Routed r ->
                new RouteStepResponseDTO(r.harnessId(), r.policyUsed(), r.eligibleCount(), null);
            case RoutingDecision.NoEligibleHarness n ->
                new RouteStepResponseDTO(null, null, null, n.reason());
        };
        return ResponseEntity.ok(response);
    }
}

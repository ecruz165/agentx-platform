package com.jefelabs.agentx.controlplane.dispatch.service;

import com.jefelabs.agentx.controlplane.dispatch.domain.RoutingDecision;
import com.jefelabs.agentx.controlplane.dispatch.domain.StepContext;
import com.jefelabs.agentx.controlplane.harness.domain.Harness;
import com.jefelabs.agentx.controlplane.harness.service.HarnessService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Forwards a WORK job to a registered harness-server for execution (W1).
 *
 * <p>Flow: build a {@link StepContext} for the whole job → ask
 * {@link HarnessRouter} for an eligible harness → read its
 * {@code endpoints.tcp} (registered by the harness-server launcher once
 * it bound a TCP listener) → POST the translated job to
 * {@code {tcp}/v1/jobs}. harness-core (inside the harness-server) walks
 * the entire flow graph from there; status flows back via W1d.
 *
 * <p>JOB_DEFINITION / POST_JOB flows never reach here — those run in the
 * in-process {@code JobEngine}. The {@code kind}-based split lives in
 * {@code JobService.submit}.
 */
@Service
public class HarnessForwardingService {

    private static final Logger log = LoggerFactory.getLogger(HarnessForwardingService.class);

    private final HarnessRouter router;
    private final HarnessService harnessService;
    private final RestClient http = RestClient.create();

    public HarnessForwardingService(HarnessRouter router, HarnessService harnessService) {
        this.router = router;
        this.harnessService = harnessService;
    }

    /**
     * Route + forward. Returns the harnessId the job was dispatched to.
     *
     * @throws IllegalStateException when no harness is eligible, or the
     *     routed harness has no {@code endpoints.tcp} (UDS-only). Lets
     *     {@link RestClient} exceptions propagate on transport failure.
     *     The caller decides whether a dispatch failure fails the submit
     *     or leaves the job QUEUED for retry.
     */
    public String forward(String orgId, String jobId, String flowId, String productId,
                          JsonNode input, String setName) {
        var ctx = new StepContext(orgId, jobId, jobId, productId, List.of(), StepContext.AffinityHint.NONE);
        String harnessId = switch (router.routeStep(ctx)) {
            case RoutingDecision.Routed r -> r.harnessId();
            case RoutingDecision.NoEligibleHarness n ->
                throw new IllegalStateException("no eligible harness for job " + jobId + ": " + n.reason());
        };

        Harness h = harnessService.findById(orgId, harnessId)
            .orElseThrow(() -> new IllegalStateException("routed to harness " + harnessId + " but it was not found"));
        String tcp = h.endpoints() != null ? h.endpoints().path("tcp").asText() : "";
        if (tcp == null || tcp.isBlank()) {
            throw new IllegalStateException(
                "harness " + harnessId + " has no endpoints.tcp — cannot forward (UDS-only registration?)");
        }

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("jobId", jobId);
        if (flowId != null) body.put("pipeline", flowId);   // omit ⇒ harness-server's entry coordinator routes
        body.put("input", toIntentText(input));
        if (setName != null) body.put("set", setName);
        if (productId != null) body.put("productId", productId);
        body.put("submittedAt", Instant.now().toString());

        String url = tcp.replaceAll("/+$", "") + "/v1/jobs";
        log.info("forwarding job {} to harness {} ({})", jobId, harnessId, url);
        http.post()
            .uri(url)
            .header("Content-Type", "application/json")
            .body(body)
            .retrieve()
            .toBodilessEntity();
        return harnessId;
    }

    /**
     * harness-server reads {@code body.input} as a string (the intent
     * text). A string node → its text; an object/array (e.g.
     * {@code {"change":"..."}} from the web-UI submit form) → its JSON
     * form (the entry coordinator gets the text either way); null → "".
     */
    private static String toIntentText(JsonNode input) {
        if (input == null || input.isNull()) return "";
        if (input.isObject() || input.isArray()) return input.toString();
        return input.asText();
    }
}

package com.jefelabs.agentx.controlplane.job.engine;

import com.jefelabs.agentx.controlplane.catalog.domain.Flow;
import com.jefelabs.agentx.controlplane.catalog.service.FlowService;
import com.jefelabs.agentx.controlplane.job.domain.Job;
import com.jefelabs.agentx.controlplane.job.domain.JobStatus;
import com.jefelabs.agentx.controlplane.job.domain.StepStatus;
import com.jefelabs.agentx.controlplane.job.persistence.JobDao;
import com.jefelabs.agentx.controlplane.job.persistence.JobEventDao;
import com.jefelabs.agentx.controlplane.job.persistence.JobStepDao;
import org.jdbi.v3.core.Jdbi;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Hand-rolled job execution engine — walks a FlowDef from its trigger
 * node forward, dispatching each non-trigger node to its registered
 * {@link StepKindHandler}, until a terminal verdict (or pause).
 *
 * <p>Per umbrella PRD D3 + the SSM analysis: the engine isn't an FSM,
 * it's a graph interpreter. State graphs are per-instance (each Job has
 * its own FlowDef); control flow primitives (Loop, Fork, Map, Conditional)
 * are step kinds, not framework constructs.
 *
 * <p>Phase 3b ships only the {@code succeed} handler — first proof that
 * the engine wires up cleanly across catalog + dispatch + harness modules.
 * {@code agent}, {@code transform}, and the remaining 13 step kinds land
 * in subsequent slices (3b.2 through 3f).
 */
@Service
public class JobEngine {

    private static final Logger log = LoggerFactory.getLogger(JobEngine.class);

    private final Jdbi jdbi;
    private final ObjectMapper objectMapper;
    private final FlowService flowService;
    private final Map<String, StepKindHandler> handlersByKind;

    public JobEngine(Jdbi jdbi, ObjectMapper objectMapper, FlowService flowService,
                     List<StepKindHandler> handlers) {
        this.jdbi = jdbi;
        this.objectMapper = objectMapper;
        this.flowService = flowService;
        this.handlersByKind = handlers.stream()
            .collect(Collectors.toUnmodifiableMap(StepKindHandler::kind, Function.identity()));
        log.info("JobEngine initialized with {} step-kind handlers: {}",
            handlersByKind.size(), handlersByKind.keySet());
    }

    /**
     * Run a queued or running job to its next pause point or terminal.
     * Returns the post-run snapshot. The Phase 3b walk runs synchronously;
     * Phase 3.x switches to {@code @Async} virtual-threaded execution
     * so submission stays non-blocking.
     */
    @Transactional
    public Job runJob(Job initial) {
        if (initial.status() != JobStatus.QUEUED && initial.status() != JobStatus.RUNNING) {
            log.debug("Skipping run for job {} in status {}", initial.id(), initial.status());
            return initial;
        }

        JobDao jobDao = jdbi.onDemand(JobDao.class);
        JobStepDao stepDao = jdbi.onDemand(JobStepDao.class);
        JobEventDao eventDao = jdbi.onDemand(JobEventDao.class);

        // Load FlowDef from catalog
        Flow flow = flowService.findById(initial.orgId(), initial.flowId())
            .orElseThrow(() -> new IllegalStateException(
                "Flow not found in catalog: " + initial.flowId() + " (org=" + initial.orgId() + ")"));

        JsonNode flowJson = buildFlowJson(flow);
        emit(eventDao, initial, "job-started", null, null);
        jobDao.markRunning(initial.orgId(), initial.id());

        // Walk: start from the trigger's outgoing edge
        String triggerNodeId = findTriggerNodeId(flowJson)
            .orElseThrow(() -> new IllegalStateException("FlowDef has no trigger node: " + flow.id()));

        String currentNodeId = followEdge(flowJson, triggerNodeId)
            .orElse(null);  // empty flow: trigger with no outgoing edge → succeed immediately
        JsonNode priorOutput = initial.input();

        // BodyRunner instance for compound step kinds (Loop, Fork, etc.); per-job attempt
        // counter so each body invocation lands in its own job_steps row.
        Map<String, Integer> bodyAttemptCounter = new HashMap<>();
        BodyRunner bodyRunner = (bodyId, bodyInput) ->
            executeBody(initial, flowJson, bodyId, bodyInput, bodyAttemptCounter, stepDao, eventDao);

        Job job = initial;
        while (currentNodeId != null) {
            final String nodeId = currentNodeId;  // effectively-final capture for orElseThrow lambda
            JsonNode node = findNode(flowJson, nodeId)
                .orElseThrow(() -> new IllegalStateException("Edge points to missing node: " + nodeId));
            String nodeKind = node.path("kind").asText();

            StepKindHandler handler = handlersByKind.get(nodeKind);
            if (handler == null) {
                String reason = "no handler registered for step kind: " + nodeKind;
                log.warn("Job {} step {} {}", job.id(), currentNodeId, reason);
                stepDao.startStep(job.orgId(), job.id(), currentNodeId, 1, StepStatus.FAILED, null, writeJson(priorOutput));
                stepDao.completeStep(job.orgId(), job.id(), currentNodeId, 1, StepStatus.FAILED, null, reason);
                emit(eventDao, job, "step-failed", currentNodeId, errorPayload(reason));
                jobDao.markFailed(job.orgId(), job.id(), reason);
                return jobDao.findById(job.orgId(), job.id()).map(this::reload).orElse(job);
            }

            stepDao.startStep(job.orgId(), job.id(), currentNodeId, 1, StepStatus.RUNNING, null, writeJson(priorOutput));
            emit(eventDao, job, "step-started", currentNodeId, null);

            StepResult result;
            try {
                result = handler.execute(new StepContext(job, flowJson, node, currentNodeId, nodeKind, priorOutput, bodyRunner));
            } catch (RuntimeException e) {
                String reason = "handler threw: " + e.getMessage();
                log.warn("Job {} step {} handler exception", job.id(), currentNodeId, e);
                stepDao.completeStep(job.orgId(), job.id(), currentNodeId, 1, StepStatus.FAILED, null, reason);
                emit(eventDao, job, "step-failed", currentNodeId, errorPayload(reason));
                jobDao.markFailed(job.orgId(), job.id(), reason);
                return jobDao.findById(job.orgId(), job.id()).map(this::reload).orElse(job);
            }

            switch (result) {
                case StepResult.Advance advance -> {
                    stepDao.completeStep(job.orgId(), job.id(), currentNodeId, 1,
                        StepStatus.COMPLETED, writeJson(advance.output()), null);
                    emit(eventDao, job, "step-completed", currentNodeId, null);
                    priorOutput = advance.output();
                    currentNodeId = followEdge(flowJson, currentNodeId, advance.edgeLabel()).orElse(null);
                }
                case StepResult.TerminateSuccess success -> {
                    stepDao.completeStep(job.orgId(), job.id(), currentNodeId, 1,
                        StepStatus.COMPLETED, writeJson(success.output()), null);
                    emit(eventDao, job, "step-completed", currentNodeId, null);
                    emit(eventDao, job, "job-completed", null, null);
                    jobDao.markCompleted(job.orgId(), job.id(), writeJson(success.output()));
                    return jobDao.findById(job.orgId(), job.id()).map(this::reload).orElse(job);
                }
                case StepResult.TerminateFailure failure -> {
                    stepDao.completeStep(job.orgId(), job.id(), currentNodeId, 1,
                        StepStatus.FAILED, null, failure.reason());
                    emit(eventDao, job, "step-failed", currentNodeId, errorPayload(failure.reason()));
                    jobDao.markFailed(job.orgId(), job.id(), failure.reason());
                    return jobDao.findById(job.orgId(), job.id()).map(this::reload).orElse(job);
                }
                case StepResult.Pause pause -> {
                    emit(eventDao, job, "step-paused", currentNodeId, errorPayload(pause.reason()));
                    return jobDao.findById(job.orgId(), job.id()).map(this::reload).orElse(job);
                }
            }
        }

        // Walked off the end of the graph with no terminal — treat as success with the last output
        emit(eventDao, job, "job-completed", null, null);
        jobDao.markCompleted(job.orgId(), job.id(), writeJson(priorOutput));
        return jobDao.findById(job.orgId(), job.id()).map(this::reload).orElse(job);
    }

    // ── BodyRunner: in-line node execution for compound step kinds ────────

    /**
     * Run a single node as a child execution. Used by Loop (and later Fork +
     * Map + Call) to invoke other handlers inline. Each invocation creates a
     * fresh job_steps row with attempt = N for tracing; non-Advance verdicts
     * propagate to the parent handler as a {@link BodyRunner.BodyExecutionException}.
     */
    private JsonNode executeBody(
        Job job,
        JsonNode flowJson,
        String bodyNodeId,
        JsonNode bodyInput,
        Map<String, Integer> attemptCounter,
        JobStepDao stepDao,
        JobEventDao eventDao
    ) {
        JsonNode bodyNode = findNode(flowJson, bodyNodeId)
            .orElseThrow(() -> new IllegalStateException("body node not found: " + bodyNodeId));
        String bodyKind = bodyNode.path("kind").asText();
        StepKindHandler handler = handlersByKind.get(bodyKind);
        if (handler == null) {
            throw new IllegalStateException("no handler for body step kind: " + bodyKind);
        }

        int attempt = attemptCounter.merge(bodyNodeId, 1, Integer::sum);
        stepDao.startStep(job.orgId(), job.id(), bodyNodeId, attempt, StepStatus.RUNNING, null, writeJson(bodyInput));
        emit(eventDao, job, "step-started", bodyNodeId, null);

        // Re-bind a BodyRunner for nested compound steps (Loop-of-Loop, etc.)
        BodyRunner nested = (id, input) -> executeBody(job, flowJson, id, input, attemptCounter, stepDao, eventDao);
        StepContext bodyCtx = new StepContext(job, flowJson, bodyNode, bodyNodeId, bodyKind, bodyInput, nested);

        StepResult bodyResult;
        try {
            bodyResult = handler.execute(bodyCtx);
        } catch (RuntimeException e) {
            stepDao.completeStep(job.orgId(), job.id(), bodyNodeId, attempt, StepStatus.FAILED, null, e.getMessage());
            emit(eventDao, job, "step-failed", bodyNodeId, errorPayload(e.getMessage()));
            throw e;
        }

        return switch (bodyResult) {
            case StepResult.Advance advance -> {
                stepDao.completeStep(job.orgId(), job.id(), bodyNodeId, attempt,
                    StepStatus.COMPLETED, writeJson(advance.output()), null);
                emit(eventDao, job, "step-completed", bodyNodeId, null);
                yield advance.output();
            }
            case StepResult.TerminateSuccess success -> {
                stepDao.completeStep(job.orgId(), job.id(), bodyNodeId, attempt,
                    StepStatus.COMPLETED, writeJson(success.output()), null);
                emit(eventDao, job, "step-completed", bodyNodeId, null);
                throw new BodyRunner.BodyExecutionException(bodyNodeId, bodyResult,
                    "body returned TerminateSuccess — parent handler should propagate");
            }
            case StepResult.TerminateFailure failure -> {
                stepDao.completeStep(job.orgId(), job.id(), bodyNodeId, attempt,
                    StepStatus.FAILED, null, failure.reason());
                emit(eventDao, job, "step-failed", bodyNodeId, errorPayload(failure.reason()));
                throw new BodyRunner.BodyExecutionException(bodyNodeId, bodyResult, failure.reason());
            }
            case StepResult.Pause pause ->
                throw new BodyRunner.BodyExecutionException(bodyNodeId, bodyResult,
                    "body steps cannot Pause in Phase 3c; got: " + pause.reason());
        };
    }

    // ── FlowDef walking helpers ────────────────────────────────────────────

    private JsonNode buildFlowJson(Flow flow) {
        var root = objectMapper.createObjectNode();
        root.put("id", flow.id());
        root.set("nodes", flow.nodes() != null ? flow.nodes() : objectMapper.createArrayNode());
        root.set("edges", flow.edges() != null ? flow.edges() : objectMapper.createArrayNode());
        return root;
    }

    private Optional<String> findTriggerNodeId(JsonNode flow) {
        for (JsonNode node : flow.path("nodes")) {
            if ("trigger".equals(node.path("kind").asText())) {
                return Optional.of(node.path("id").asText());
            }
        }
        return Optional.empty();
    }

    private Optional<JsonNode> findNode(JsonNode flow, String nodeId) {
        for (JsonNode node : flow.path("nodes")) {
            if (nodeId.equals(node.path("id").asText())) {
                return Optional.of(node);
            }
        }
        return Optional.empty();
    }

    private Optional<String> followEdge(JsonNode flow, String fromNodeId) {
        return followEdge(flow, fromNodeId, null);
    }

    /**
     * Follow an outgoing edge from {@code fromNodeId}, preferring an edge whose
     * {@code label} matches {@code preferredLabel}. When {@code preferredLabel}
     * is null OR no matching label is found, fall back to the first unlabeled
     * edge. Returns empty when no suitable edge exists (engine treats as the
     * normal walk-off-end completion).
     */
    private Optional<String> followEdge(JsonNode flow, String fromNodeId, String preferredLabel) {
        String unlabeledTarget = null;
        for (JsonNode edge : flow.path("edges")) {
            if (!fromNodeId.equals(edge.path("source").asText())) continue;
            String label = edge.path("label").asText("");
            String target = edge.path("target").asText();
            if (target.isEmpty()) continue;
            if (preferredLabel != null && preferredLabel.equals(label)) {
                return Optional.of(target);
            }
            if (label.isEmpty() && unlabeledTarget == null) {
                unlabeledTarget = target;
            }
        }
        return Optional.ofNullable(unlabeledTarget);
    }

    // ── persistence helpers ────────────────────────────────────────────────

    private Job reload(Object daoRow) {
        // The JobDao.findById signature returns Optional<JobDaoRow>; we re-use
        // JobService's row→domain mapping by routing through it would create a
        // peer dependency. Cheaper: round-trip through the same conversion here.
        // (Phase 3.x can extract a JobMapping helper if this duplication grows.)
        var row = (com.jefelabs.agentx.controlplane.job.persistence.JobDaoRow) daoRow;
        return new Job(
            row.orgId(), row.id(), row.flowId(), row.productId(), row.status(),
            readJson(row.input()), row.setName(), readJson(row.config()), readJson(row.output()),
            row.failureReason(), row.currentNodeId(),
            row.createdAt(), row.startedAt(), row.completedAt(), row.createdBy()
        );
    }

    private void emit(JobEventDao eventDao, Job job, String eventType, String nodeId, JsonNode payload) {
        eventDao.emit(job.orgId(), job.id(), eventType, nodeId, writeJson(payload));
    }

    private JsonNode errorPayload(String reason) {
        var node = objectMapper.createObjectNode();
        node.put("reason", reason);
        return node;
    }

    private JsonNode readJson(String json) {
        if (json == null) return null;
        try { return objectMapper.readTree(json); }
        catch (JacksonException e) { throw new IllegalStateException("Stored JSON parse failed", e); }
    }

    private String writeJson(JsonNode node) {
        if (node == null) return null;
        try { return objectMapper.writeValueAsString(node); }
        catch (JacksonException e) { throw new IllegalArgumentException("Failed to serialize JsonNode", e); }
    }
}

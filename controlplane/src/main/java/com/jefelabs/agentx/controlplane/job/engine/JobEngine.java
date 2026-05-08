package com.jefelabs.agentx.controlplane.job.engine;

import com.jefelabs.agentx.controlplane.catalog.domain.Flow;
import com.jefelabs.agentx.controlplane.catalog.domain.FlowKind;
import com.jefelabs.agentx.controlplane.catalog.service.FlowService;
import com.jefelabs.agentx.controlplane.core.events.JobIntentProducedEvent;
import com.jefelabs.agentx.controlplane.job.domain.Job;
import com.jefelabs.agentx.controlplane.job.domain.JobStatus;
import com.jefelabs.agentx.controlplane.job.domain.StepStatus;
import com.jefelabs.agentx.controlplane.job.persistence.JobDao;
import com.jefelabs.agentx.controlplane.job.persistence.JobEventDao;
import com.jefelabs.agentx.controlplane.job.persistence.JobStepDao;
import org.jdbi.v3.core.Jdbi;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
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
    private final ApplicationEventPublisher eventPublisher;
    private final Map<String, StepKindHandler> handlersByKind;

    public JobEngine(Jdbi jdbi, ObjectMapper objectMapper, FlowService flowService,
                     ApplicationEventPublisher eventPublisher,
                     List<StepKindHandler> handlers) {
        this.jdbi = jdbi;
        this.objectMapper = objectMapper;
        this.flowService = flowService;
        this.eventPublisher = eventPublisher;
        this.handlersByKind = handlers.stream()
            .collect(Collectors.toUnmodifiableMap(StepKindHandler::kind, Function.identity()));
        log.info("JobEngine initialized with {} step-kind handlers: {}",
            handlersByKind.size(), handlersByKind.keySet());
    }

    /**
     * Wraps {@code jobDao.markCompleted} with the cross-module event
     * emission (Phase 5.5 hook): when the underlying flow has
     * {@code kind == 'job-definition'}, publish a
     * {@link JobIntentProducedEvent} carrying the output as the
     * resolved JobIntent. The Intent module listens and transitions the
     * matching session to {@code intent-ready}.
     *
     * <p>Falls back to a plain markCompleted when the flow can't be
     * loaded (e.g., catalog row deleted mid-run) or kind is not
     * job-definition. The flow lookup fires once per job (terminal),
     * so the cost is negligible.
     */
    private void completeJob(JobDao jobDao, Job job, JsonNode output) {
        jobDao.markCompleted(job.orgId(), job.id(), writeJson(output));
        flowService.findById(job.orgId(), job.flowId()).ifPresent(flow -> {
            if (flow.kind() == FlowKind.JOB_DEFINITION) {
                eventPublisher.publishEvent(new JobIntentProducedEvent(
                    job.orgId(), job.id(), job.flowId(), output
                ));
                log.debug("Published JobIntentProducedEvent: jobId={} flowId={}",
                    job.id(), job.flowId());
            }
        });
    }

    /**
     * Run a queued or running job to its next pause point or terminal.
     * Returns the post-run snapshot. The Phase 3b walk runs synchronously;
     * Phase 3.x switches to {@code @Async} virtual-threaded execution
     * so submission stays non-blocking.
     *
     * <p><b>NOT {@code @Transactional}</b> as of Phase 3c.3 — each DAO call
     * auto-commits independently so (a) Fork/Map parallel virtual-thread
     * branches don't fight over the parent's transaction context, and
     * (b) the audit trail (job_steps + job_events) survives partial-failure
     * recovery scenarios. JobService.submit's @Transactional handles atomic
     * job creation; runtime execution is event-streamed semantics.
     */
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
        // ConcurrentHashMap because Fork/Map dispatch branches in parallel virtual threads
        // and share this counter for shared body node ids.
        Map<String, Integer> bodyAttemptCounter = new ConcurrentHashMap<>();
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
                    completeJob(jobDao, job, success.output());
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
                    // Pause is a real pause: leave the job in RUNNING with current_node_id
                    // pointing here. Resume API re-engages via resumeJob(...).
                    jobDao.setCurrentNode(job.orgId(), job.id(), currentNodeId);
                    emit(eventDao, job, "step-paused", currentNodeId, errorPayload(pause.reason()));
                    return jobDao.findById(job.orgId(), job.id()).map(this::reload).orElse(job);
                }
            }
        }

        // Walked off the end of the graph with no terminal — treat as success with the last output
        emit(eventDao, job, "job-completed", null, null);
        completeJob(jobDao, job, priorOutput);
        return jobDao.findById(job.orgId(), job.id()).map(this::reload).orElse(job);
    }

    /**
     * Resume a paused job at its {@code current_node_id} with delivered
     * {@code resumeData}. The handler at the paused node sees
     * {@link StepContext#isResume()} == true + {@link StepContext#resumeData()}
     * populated, typically returns Advance, and the engine continues the walk.
     *
     * <p>Phase 3e MVP only resumes top-level paused nodes (not steps inside
     * Loop / Fork / Map bodies); a paused approval inside a loop iteration
     * is undefined behavior in this slice.
     */
    public Job resumeJob(Job job, JsonNode resumeData) {
        if (job.status() != JobStatus.RUNNING) {
            log.debug("resumeJob: job {} not RUNNING (status={}); skipping", job.id(), job.status());
            return job;
        }
        String pausedNodeId = job.currentNodeId();
        if (pausedNodeId == null) {
            log.warn("resumeJob: job {} has no current_node_id; cannot resume", job.id());
            return job;
        }

        JobDao jobDao = jdbi.onDemand(JobDao.class);
        JobStepDao stepDao = jdbi.onDemand(JobStepDao.class);
        JobEventDao eventDao = jdbi.onDemand(JobEventDao.class);

        Flow flow = flowService.findById(job.orgId(), job.flowId())
            .orElseThrow(() -> new IllegalStateException(
                "Flow not found in catalog: " + job.flowId() + " (org=" + job.orgId() + ")"));
        JsonNode flowJson = buildFlowJson(flow);

        JsonNode pausedNode = findNode(flowJson, pausedNodeId)
            .orElseThrow(() -> new IllegalStateException("paused node missing from FlowDef: " + pausedNodeId));
        String pausedKind = pausedNode.path("kind").asText();
        StepKindHandler handler = handlersByKind.get(pausedKind);
        if (handler == null) {
            String reason = "no handler for paused step kind: " + pausedKind;
            jobDao.markFailed(job.orgId(), job.id(), reason);
            emit(eventDao, job, "job-failed", pausedNodeId, errorPayload(reason));
            return jobDao.findById(job.orgId(), job.id()).map(this::reload).orElse(job);
        }

        emit(eventDao, job, "step-resumed", pausedNodeId, null);

        Map<String, Integer> bodyAttemptCounter = new ConcurrentHashMap<>();
        BodyRunner bodyRunner = (bodyId, bodyInput) ->
            executeBody(job, flowJson, bodyId, bodyInput, bodyAttemptCounter, stepDao, eventDao);

        // First invocation: paused-step's handler with resumeData.
        StepResult firstResult;
        try {
            firstResult = handler.execute(new StepContext(
                job, flowJson, pausedNode, pausedNodeId, pausedKind,
                /* priorOutput */ null,  // resume doesn't carry the original priorOutput; handler uses resumeData
                bodyRunner, resumeData
            ));
        } catch (RuntimeException e) {
            stepDao.completeStep(job.orgId(), job.id(), pausedNodeId, 1, StepStatus.FAILED, null, e.getMessage());
            emit(eventDao, job, "step-failed", pausedNodeId, errorPayload(e.getMessage()));
            jobDao.markFailed(job.orgId(), job.id(), e.getMessage());
            return jobDao.findById(job.orgId(), job.id()).map(this::reload).orElse(job);
        }

        // Handle the first result; if Advance, continue walking from the next node.
        switch (firstResult) {
            case StepResult.Advance advance -> {
                stepDao.completeStep(job.orgId(), job.id(), pausedNodeId, 1,
                    StepStatus.COMPLETED, writeJson(advance.output()), null);
                emit(eventDao, job, "step-completed", pausedNodeId, null);
                jobDao.setCurrentNode(job.orgId(), job.id(), null);
                String nextNodeId = followEdge(flowJson, pausedNodeId, advance.edgeLabel()).orElse(null);
                return continueWalk(job, flowJson, nextNodeId, advance.output(), bodyRunner, bodyAttemptCounter, stepDao, eventDao, jobDao);
            }
            case StepResult.TerminateSuccess success -> {
                stepDao.completeStep(job.orgId(), job.id(), pausedNodeId, 1,
                    StepStatus.COMPLETED, writeJson(success.output()), null);
                emit(eventDao, job, "step-completed", pausedNodeId, null);
                emit(eventDao, job, "job-completed", null, null);
                completeJob(jobDao, job, success.output());
                return jobDao.findById(job.orgId(), job.id()).map(this::reload).orElse(job);
            }
            case StepResult.TerminateFailure failure -> {
                stepDao.completeStep(job.orgId(), job.id(), pausedNodeId, 1,
                    StepStatus.FAILED, null, failure.reason());
                emit(eventDao, job, "step-failed", pausedNodeId, errorPayload(failure.reason()));
                jobDao.markFailed(job.orgId(), job.id(), failure.reason());
                return jobDao.findById(job.orgId(), job.id()).map(this::reload).orElse(job);
            }
            case StepResult.Pause pause -> {
                // Re-paused (handler decided it needs more data) — just stay paused.
                emit(eventDao, job, "step-paused", pausedNodeId, errorPayload(pause.reason()));
                return jobDao.findById(job.orgId(), job.id()).map(this::reload).orElse(job);
            }
        }
    }

    /**
     * Continue walking the FlowDef from {@code startNodeId} after a resume's
     * paused-step handler returned Advance. Mirrors the main runJob loop body
     * but starts at an arbitrary node with arbitrary priorOutput.
     */
    private Job continueWalk(
        Job job,
        JsonNode flowJson,
        String startNodeId,
        JsonNode initialPriorOutput,
        BodyRunner bodyRunner,
        Map<String, Integer> bodyAttemptCounter,
        JobStepDao stepDao,
        JobEventDao eventDao,
        JobDao jobDao
    ) {
        String currentNodeId = startNodeId;
        JsonNode priorOutput = initialPriorOutput;

        while (currentNodeId != null) {
            final String nodeId = currentNodeId;
            JsonNode node = findNode(flowJson, nodeId)
                .orElseThrow(() -> new IllegalStateException("Edge points to missing node: " + nodeId));
            String nodeKind = node.path("kind").asText();
            StepKindHandler handler = handlersByKind.get(nodeKind);
            if (handler == null) {
                String reason = "no handler registered for step kind: " + nodeKind;
                stepDao.startStep(job.orgId(), job.id(), nodeId, 1, StepStatus.FAILED, null, writeJson(priorOutput));
                stepDao.completeStep(job.orgId(), job.id(), nodeId, 1, StepStatus.FAILED, null, reason);
                emit(eventDao, job, "step-failed", nodeId, errorPayload(reason));
                jobDao.markFailed(job.orgId(), job.id(), reason);
                return jobDao.findById(job.orgId(), job.id()).map(this::reload).orElse(job);
            }

            stepDao.startStep(job.orgId(), job.id(), nodeId, 1, StepStatus.RUNNING, null, writeJson(priorOutput));
            emit(eventDao, job, "step-started", nodeId, null);

            StepResult result;
            try {
                result = handler.execute(new StepContext(job, flowJson, node, nodeId, nodeKind, priorOutput, bodyRunner));
            } catch (RuntimeException e) {
                stepDao.completeStep(job.orgId(), job.id(), nodeId, 1, StepStatus.FAILED, null, e.getMessage());
                emit(eventDao, job, "step-failed", nodeId, errorPayload(e.getMessage()));
                jobDao.markFailed(job.orgId(), job.id(), e.getMessage());
                return jobDao.findById(job.orgId(), job.id()).map(this::reload).orElse(job);
            }

            switch (result) {
                case StepResult.Advance advance -> {
                    stepDao.completeStep(job.orgId(), job.id(), nodeId, 1,
                        StepStatus.COMPLETED, writeJson(advance.output()), null);
                    emit(eventDao, job, "step-completed", nodeId, null);
                    priorOutput = advance.output();
                    currentNodeId = followEdge(flowJson, nodeId, advance.edgeLabel()).orElse(null);
                }
                case StepResult.TerminateSuccess success -> {
                    stepDao.completeStep(job.orgId(), job.id(), nodeId, 1,
                        StepStatus.COMPLETED, writeJson(success.output()), null);
                    emit(eventDao, job, "step-completed", nodeId, null);
                    emit(eventDao, job, "job-completed", null, null);
                    completeJob(jobDao, job, success.output());
                    return jobDao.findById(job.orgId(), job.id()).map(this::reload).orElse(job);
                }
                case StepResult.TerminateFailure failure -> {
                    stepDao.completeStep(job.orgId(), job.id(), nodeId, 1,
                        StepStatus.FAILED, null, failure.reason());
                    emit(eventDao, job, "step-failed", nodeId, errorPayload(failure.reason()));
                    jobDao.markFailed(job.orgId(), job.id(), failure.reason());
                    return jobDao.findById(job.orgId(), job.id()).map(this::reload).orElse(job);
                }
                case StepResult.Pause pause -> {
                    jobDao.setCurrentNode(job.orgId(), job.id(), nodeId);
                    emit(eventDao, job, "step-paused", nodeId, errorPayload(pause.reason()));
                    return jobDao.findById(job.orgId(), job.id()).map(this::reload).orElse(job);
                }
            }
        }

        emit(eventDao, job, "job-completed", null, null);
        completeJob(jobDao, job, priorOutput);
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
            row.benchmarkRunId(), row.benchmarkLabel(),
            row.evalScore(), row.evalRationale(), row.evalJudge(), row.evalScoredAt(),
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

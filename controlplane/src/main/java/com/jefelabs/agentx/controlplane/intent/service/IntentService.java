package com.jefelabs.agentx.controlplane.intent.service;

import com.jefelabs.agentx.controlplane.catalog.domain.Flow;
import com.jefelabs.agentx.controlplane.catalog.domain.FlowKind;
import com.jefelabs.agentx.controlplane.catalog.service.FlowService;
import com.jefelabs.agentx.controlplane.core.types.JobIntent;
import com.jefelabs.agentx.controlplane.intent.domain.IntentSession;
import com.jefelabs.agentx.controlplane.intent.domain.SessionStatus;
import com.jefelabs.agentx.controlplane.intent.persistence.SessionDao;
import com.jefelabs.agentx.controlplane.intent.persistence.SessionDaoRow;
import com.jefelabs.agentx.controlplane.intent.sse.IntentSessionEventBus;
import com.jefelabs.agentx.controlplane.intent.sse.SessionEvent;
import com.jefelabs.agentx.controlplane.job.domain.Job;
import com.jefelabs.agentx.controlplane.job.service.JobService;
import org.jdbi.v3.core.Jdbi;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Thin orchestrator over JobService for chat-driven intent capture
 * (per prd-intent-module.md D1).
 *
 * <p>Phase 5.1-5.3: session lifecycle CRUD, JSM submit glue, manual
 * confirm flow.
 *
 * <p>Phase 5.4: SSE event bus integration — every state transition
 * publishes a {@link SessionEvent} that subscribers receive on
 * {@code /api/intent/sessions/&#123;id&#125;/events}.
 *
 * <p>Phase 5.5: {@link #markIntentReady} consumes
 * {@link com.jefelabs.agentx.controlplane.core.events.JobIntentProducedEvent}
 * (via the {@code JobIntentListener}); transitions the session whose
 * intake_job_id matches to {@code intent-ready}.
 *
 * <p>Phase 5.6: {@link #approvePipelineCreation} writes a proposed
 * PipelineDef to the catalog and rewinds the session to {@code processing}
 * so the intake loop finds the new pipeline. The architect runtime that
 * produces proposals isn't wired yet (depends on the {@code call} step
 * kind), so {@link #markPipelineCreationRequired} has no producer in
 * v1 — included as forward-compat scaffolding for the listener.
 */
@Service
public class IntentService {

    private static final Logger log = LoggerFactory.getLogger(IntentService.class);

    private final Jdbi jdbi;
    private final ObjectMapper objectMapper;
    private final JobService jobService;
    private final FlowService flowService;
    private final IntentSessionEventBus eventBus;

    public IntentService(
        Jdbi jdbi,
        ObjectMapper objectMapper,
        JobService jobService,
        FlowService flowService,
        IntentSessionEventBus eventBus
    ) {
        this.jdbi = jdbi;
        this.objectMapper = objectMapper;
        this.jobService = jobService;
        this.flowService = flowService;
        this.eventBus = eventBus;
    }

    @Transactional
    public IntentSession startSession(
        String orgId, String userId,
        String intakePipelineId, String productId,
        JsonNode initialInput
    ) {
        JobIntent intakeIntent = new JobIntent(
            intakePipelineId, productId,
            initialInput != null ? initialInput : objectMapper.nullNode(),
            null, null
        );
        Job intakeJob = jobService.submit(orgId, userId, intakeIntent);

        SessionDao dao = jdbi.onDemand(SessionDao.class);
        UUID sessionId = dao.create(
            orgId, userId, intakePipelineId, intakeJob.id(),
            SessionStatus.AWAITING_MESSAGE
        );
        IntentSession session = dao.findById(orgId, sessionId)
            .map(this::toDomain)
            .orElseThrow(() -> new IllegalStateException("Session insert succeeded but row missing: " + sessionId));

        eventBus.publish(new SessionEvent.SessionStarted(session.id(), Instant.now(), intakeJob.id()));
        return session;
    }

    public Optional<IntentSession> findById(String orgId, UUID id) {
        return jdbi.onDemand(SessionDao.class).findById(orgId, id).map(this::toDomain);
    }

    public List<IntentSession> listByOrg(String orgId, int limit, int offset) {
        return jdbi.onDemand(SessionDao.class).listByOrg(orgId, limit, offset).stream()
            .map(this::toDomain)
            .toList();
    }

    @Transactional
    public Optional<IntentSession> abort(String orgId, UUID id) {
        SessionDao dao = jdbi.onDemand(SessionDao.class);
        int updated = dao.transitionStatus(orgId, id, SessionStatus.ABORTED,
            List.of("awaiting-message", "processing", "intent-ready", "pipeline-creation-required"));
        if (updated == 0) return Optional.empty();
        eventBus.publish(new SessionEvent.Aborted(id, Instant.now()));
        return dao.findById(orgId, id).map(this::toDomain);
    }

    public Optional<IntentSession> deliverMessage(String orgId, UUID id, String message) {
        IntentSession session = findById(orgId, id).orElse(null);
        if (session == null) return Optional.empty();
        if (session.intakeJobId() == null) {
            throw new IllegalStateException("Session " + id + " has no intake job");
        }

        JsonNode payload = objectMapper.createObjectNode().put("message", message);
        jobService.deliverEvent(orgId, session.intakeJobId(), "user-message", payload);

        SessionDao dao = jdbi.onDemand(SessionDao.class);
        dao.transitionStatus(orgId, id, SessionStatus.PROCESSING,
            List.of("awaiting-message", "processing", "intent-ready"));
        return dao.findById(orgId, id).map(this::toDomain);
    }

    @Transactional
    public Optional<IntentSession> confirm(String orgId, UUID id, JobIntent workIntent, String userId) {
        IntentSession session = findById(orgId, id).orElse(null);
        if (session == null) return Optional.empty();
        if (session.status() == SessionStatus.SUBMITTED
            || session.status() == SessionStatus.ABORTED
            || session.status() == SessionStatus.EXPIRED) {
            throw new IllegalStateException(
                "Session " + id + " is terminal (" + session.status() + ")");
        }

        Job workJob = jobService.submit(orgId, userId, workIntent);

        SessionDao dao = jdbi.onDemand(SessionDao.class);
        int updated = dao.markSubmitted(orgId, id, workJob.id(), writeJson(toJson(workIntent)));
        if (updated == 0) {
            throw new IllegalStateException("Session " + id + " could not be marked submitted");
        }

        eventBus.publish(new SessionEvent.JobSubmitted(id, Instant.now(), workJob.id()));
        return dao.findById(orgId, id).map(this::toDomain);
    }

    /**
     * Phase 5.5 — invoked by {@code JobIntentListener} when a
     * job-definition flow completes. Locates the session by
     * intake_job_id and transitions to {@code intent-ready}.
     * No-op if no session is bound to that job (job submitted directly,
     * not through Intent).
     */
    public void markIntentReady(String orgId, String intakeJobId, JsonNode resolvedIntent) {
        SessionDao dao = jdbi.onDemand(SessionDao.class);
        SessionDaoRow row = dao.findByIntakeJobId(orgId, intakeJobId).orElse(null);
        if (row == null) {
            log.debug("No intake session bound to job {} — listener is a no-op", intakeJobId);
            return;
        }
        int updated = dao.markIntentReady(orgId, row.id(), writeJson(resolvedIntent));
        if (updated == 0) {
            log.warn("Session {} could not transition to intent-ready (terminal state?)", row.id());
            return;
        }
        eventBus.publish(new SessionEvent.IntentReady(row.id(), Instant.now(), resolvedIntent));
    }

    /**
     * Phase 5.6 forward-compat — invoked by the listener when a
     * pipeline-architect sub-pipeline emits a proposed PipelineDef.
     * Caller-side store of the spec is the SSE event itself; the UI
     * holds the proposal client-side and re-submits it on /approve.
     */
    public void markPipelineCreationRequired(String orgId, String parentJobId, JsonNode pipelineSpec) {
        SessionDao dao = jdbi.onDemand(SessionDao.class);
        SessionDaoRow row = dao.findByIntakeJobId(orgId, parentJobId).orElse(null);
        if (row == null) {
            log.debug("No session bound to parent job {} — listener is a no-op", parentJobId);
            return;
        }
        int updated = dao.transitionStatus(orgId, row.id(),
            SessionStatus.PIPELINE_CREATION_REQUIRED,
            List.of("awaiting-message", "processing", "intent-ready"));
        if (updated == 0) {
            log.warn("Session {} could not transition to pipeline-creation-required", row.id());
            return;
        }
        eventBus.publish(new SessionEvent.PipelineCreationRequired(row.id(), Instant.now(), pipelineSpec));
    }

    /**
     * Phase 5.6 — admin approves a proposed PipelineDef. Writes it to
     * the catalog (FlowService.upsert) and rewinds the session to
     * {@code processing} so the intake job can find the new pipeline.
     * Per prd-intent-module.md F15.
     *
     * <p>The full architect-driven flow has the spec produced by an
     * architect sub-pipeline; until {@code call} step kind lands, the
     * spec arrives via the request body (operator-supplied / manual review).
     */
    @Transactional
    public Optional<IntentSession> approvePipelineCreation(
        String orgId, UUID id, String userId,
        Flow proposedFlow
    ) {
        IntentSession session = findById(orgId, id).orElse(null);
        if (session == null) return Optional.empty();
        if (session.status() != SessionStatus.PIPELINE_CREATION_REQUIRED) {
            throw new IllegalStateException(
                "Session " + id + " is not awaiting pipeline approval (status="
                + session.status() + ")");
        }

        // Default kind to WORK if caller omitted (architect proposals are work pipelines)
        FlowKind kind = proposedFlow.kind() != null ? proposedFlow.kind() : FlowKind.WORK;
        Flow withOrgAndAuthor = new Flow(
            orgId, proposedFlow.id(), proposedFlow.description(), kind,
            proposedFlow.output(), proposedFlow.nodes(), proposedFlow.edges(),
            proposedFlow.createdAt(), proposedFlow.updatedAt(),
            "pipeline-architect", userId
        );
        flowService.upsert(withOrgAndAuthor);

        SessionDao dao = jdbi.onDemand(SessionDao.class);
        dao.transitionStatus(orgId, id, SessionStatus.PROCESSING,
            List.of("pipeline-creation-required"));

        eventBus.publish(new SessionEvent.PipelineCreated(id, Instant.now(), proposedFlow.id()));
        return dao.findById(orgId, id).map(this::toDomain);
    }

    /**
     * Phase 5.6 — admin rejects a proposed PipelineDef. Session moves to
     * {@code failed} with the rejection reason. Per F18.
     */
    @Transactional
    public Optional<IntentSession> rejectPipelineCreation(String orgId, UUID id, String reason) {
        SessionDao dao = jdbi.onDemand(SessionDao.class);
        int updated = dao.transitionStatus(orgId, id, SessionStatus.FAILED,
            List.of("pipeline-creation-required"));
        if (updated == 0) return Optional.empty();
        eventBus.publish(new SessionEvent.Error(id, Instant.now(),
            "Pipeline creation rejected: " + reason));
        return dao.findById(orgId, id).map(this::toDomain);
    }

    // ── helpers ───────────────────────────────────────────────────────────

    private IntentSession toDomain(SessionDaoRow row) {
        return new IntentSession(
            row.id(), row.orgId(), row.userId(), row.intakePipelineId(),
            row.intakeJobId(), row.workJobId(), row.status(),
            readJson(row.resolvedIntent()), row.failureReason(),
            row.createdAt(), row.lastActivityAt()
        );
    }

    private JsonNode toJson(JobIntent intent) {
        var node = objectMapper.createObjectNode();
        node.put("flowId", intent.flowId());
        node.put("productId", intent.productId());
        if (intent.input() != null) node.set("input", intent.input());
        if (intent.set() != null) node.put("set", intent.set());
        if (intent.config() != null) node.set("config", intent.config());
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

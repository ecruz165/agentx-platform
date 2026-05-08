package com.jefelabs.agentx.controlplane.intent.service;

import com.jefelabs.agentx.controlplane.core.types.JobIntent;
import com.jefelabs.agentx.controlplane.intent.domain.IntentSession;
import com.jefelabs.agentx.controlplane.intent.domain.SessionStatus;
import com.jefelabs.agentx.controlplane.intent.persistence.SessionDao;
import com.jefelabs.agentx.controlplane.intent.persistence.SessionDaoRow;
import com.jefelabs.agentx.controlplane.job.domain.Job;
import com.jefelabs.agentx.controlplane.job.service.JobService;
import org.jdbi.v3.core.Jdbi;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Thin orchestrator over JobService for chat-driven intent capture
 * (per prd-intent-module.md D1). Phase 5 ships:
 *   <ul>
 *     <li>Session lifecycle (start, get, list, abort).</li>
 *     <li>JSM submit glue: {@code startSession} submits the chosen
 *         intake JobDefinitionPipeline as a real job.</li>
 *     <li>Message delivery: {@code deliverMessage} forwards user turns
 *         into the paused intake job's wait-for-event step.</li>
 *     <li>Confirm flow: {@code confirm} submits the resolved JobIntent
 *         as the work job.</li>
 *   </ul>
 *
 * <p>Out of scope until the next phase: SSE event streaming, automatic
 * {@code job-intent-produced} consumption (currently the caller passes
 * the resolved intent to {@code /confirm} explicitly), and the
 * pipeline-architect / approval flow.
 */
@Service
public class IntentService {

    private final Jdbi jdbi;
    private final ObjectMapper objectMapper;
    private final JobService jobService;

    public IntentService(Jdbi jdbi, ObjectMapper objectMapper, JobService jobService) {
        this.jdbi = jdbi;
        this.objectMapper = objectMapper;
        this.jobService = jobService;
    }

    /**
     * Start a new intake session: submits the intake pipeline as a job and
     * persists the session row pointing at it. Returns the session in
     * {@link SessionStatus#AWAITING_MESSAGE}.
     */
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
        return dao.findById(orgId, sessionId)
            .map(this::toDomain)
            .orElseThrow(() -> new IllegalStateException("Session insert succeeded but row missing: " + sessionId));
    }

    public Optional<IntentSession> findById(String orgId, UUID id) {
        return jdbi.onDemand(SessionDao.class).findById(orgId, id).map(this::toDomain);
    }

    public List<IntentSession> listByOrg(String orgId, int limit, int offset) {
        return jdbi.onDemand(SessionDao.class).listByOrg(orgId, limit, offset).stream()
            .map(this::toDomain)
            .toList();
    }

    /**
     * Move session to {@link SessionStatus#ABORTED} if it's still in
     * an open state. Caller cancels the underlying intake job separately
     * via JobService if desired.
     */
    @Transactional
    public Optional<IntentSession> abort(String orgId, UUID id) {
        SessionDao dao = jdbi.onDemand(SessionDao.class);
        int updated = dao.transitionStatus(orgId, id, SessionStatus.ABORTED,
            List.of("awaiting-message", "processing", "intent-ready"));
        return updated > 0 ? dao.findById(orgId, id).map(this::toDomain) : Optional.empty();
    }

    /**
     * Forward a user message into the intake job. Constructs a
     * {@code user-message} event with the message body and delivers it
     * via JobService. The intake pipeline is expected to be paused at a
     * {@code wait-for-event} step (otherwise JobService surfaces an
     * {@link IllegalStateException}).
     */
    public Optional<IntentSession> deliverMessage(String orgId, UUID id, String message) {
        IntentSession session = findById(orgId, id).orElse(null);
        if (session == null) return Optional.empty();
        if (session.intakeJobId() == null) {
            throw new IllegalStateException("Session " + id + " has no intake job");
        }

        JsonNode payload = objectMapper.createObjectNode().put("message", message);
        jobService.deliverEvent(orgId, session.intakeJobId(), "user-message", payload);

        // Tick last_activity_at; status stays in its current open phase.
        SessionDao dao = jdbi.onDemand(SessionDao.class);
        dao.transitionStatus(orgId, id, SessionStatus.PROCESSING,
            List.of("awaiting-message", "processing", "intent-ready"));
        return dao.findById(orgId, id).map(this::toDomain);
    }

    /**
     * Confirm the resolved intent and submit the work job. Phase 5.3
     * accepts the JobIntent in the request body — Phase 5.5 will pull
     * it from the intake job's {@code job-intent-produced} event
     * automatically.
     */
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

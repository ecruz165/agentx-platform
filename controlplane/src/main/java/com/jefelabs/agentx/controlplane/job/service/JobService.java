package com.jefelabs.agentx.controlplane.job.service;

import com.jefelabs.agentx.controlplane.catalog.domain.FlowKind;
import com.jefelabs.agentx.controlplane.catalog.service.FlowService;
import com.jefelabs.agentx.controlplane.core.types.JobIntent;
import com.jefelabs.agentx.controlplane.dispatch.service.HarnessForwardingService;
import com.jefelabs.agentx.controlplane.job.domain.Job;
import com.jefelabs.agentx.controlplane.job.domain.JobStatus;
import com.jefelabs.agentx.controlplane.job.engine.JobEngine;
import com.jefelabs.agentx.controlplane.job.persistence.JobDao;
import com.jefelabs.agentx.controlplane.job.persistence.JobDaoRow;
import org.jdbi.v3.core.Jdbi;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Job submission + lifecycle service. Phase 3a: implements submission,
 * read, and cancel — execution is hand-rolled engine work that arrives
 * with the step-kind handlers in Phase 3b.
 *
 * <p>The single canonical submission entry point takes a {@link JobIntent}
 * (shared-kernel type from {@code core/types}). The HTTP controller maps
 * its DTO to a JobIntent before calling here; the future Intent module
 * will call this method directly with the same shape.
 */
@Service
public class JobService {

    private static final Logger log = LoggerFactory.getLogger(JobService.class);

    private final Jdbi jdbi;
    private final ObjectMapper objectMapper;
    private final JobEngine jobEngine;
    private final FlowService flowService;
    private final HarnessForwardingService harnessForwardingService;

    public JobService(
        Jdbi jdbi,
        ObjectMapper objectMapper,
        @org.springframework.context.annotation.Lazy JobEngine jobEngine,
        FlowService flowService,
        HarnessForwardingService harnessForwardingService
    ) {
        this.jdbi = jdbi;
        this.objectMapper = objectMapper;
        this.jobEngine = jobEngine;
        this.flowService = flowService;
        this.harnessForwardingService = harnessForwardingService;
    }

    /**
     * Materialize a {@link JobIntent} into a persisted {@link Job} in
     * {@link JobStatus#QUEUED} state. Phase 3b's engine picks up queued
     * jobs and walks the FlowDef from there.
     */
    @Transactional
    public Job submit(String orgId, String createdBy, JobIntent intent) {
        String id = "job-" + UUID.randomUUID();

        // Extract benchmark tags from config if present:
        //   { "benchmark": { "runId": "abc", "label": "qwen-0.6b run-1" } }
        // Used by `workspace bench` to group N jobs of one run for compare.
        String benchmarkRunId = null;
        String benchmarkLabel = null;
        if (intent.config() != null && intent.config().has("benchmark")) {
            JsonNode b = intent.config().get("benchmark");
            if (b != null && b.isObject()) {
                if (b.hasNonNull("runId")) benchmarkRunId = b.get("runId").asText();
                if (b.hasNonNull("label")) benchmarkLabel = b.get("label").asText();
            }
        }

        // Extract estimatedPoints if present (slice 6 — story-point estimation).
        Double estimatedPoints = null;
        if (intent.config() != null && intent.config().hasNonNull("estimatedPoints")) {
            estimatedPoints = intent.config().get("estimatedPoints").asDouble();
        }

        JobDao dao = jdbi.onDemand(JobDao.class);
        dao.insert(
            orgId, id,
            intent.flowId(), intent.productId(),
            JobStatus.QUEUED,
            writeJson(intent.input()),
            intent.set(),
            writeJson(intent.config()),
            benchmarkRunId, benchmarkLabel,
            estimatedPoints,
            createdBy
        );

        // W1 — WORK flows execute on a harness-server; JOB_DEFINITION /
        // POST_JOB flows stay in the in-process JobEngine (triggered via
        // POST /api/jobs/{id}/start, or a future @Scheduled poller).
        // NOTE: the HTTP forward happens inside this @Transactional method
        // for the MVP — a follow-up should move it to an after-commit hook
        // so the DB connection isn't held across the call. A dispatch
        // failure leaves the job QUEUED (don't fail the submit response —
        // the job IS persisted and can be retried).
        flowService.findById(orgId, intent.flowId())
            .filter(f -> f.kind() == FlowKind.WORK)
            .ifPresent(f -> {
                try {
                    String harnessId = harnessForwardingService.forward(
                        orgId, id, intent.flowId(), intent.productId(), intent.input(), intent.set());
                    dao.recordDispatch(orgId, id, harnessId);
                    log.info("job {} (flow={}) dispatched to harness {}", id, intent.flowId(), harnessId);
                } catch (RuntimeException e) {
                    log.warn("job {} dispatch to a harness failed (left QUEUED): {}", id, e.getMessage());
                }
            });

        return dao.findById(orgId, id)
            .map(this::toDomain)
            .orElseThrow(() -> new IllegalStateException("Insert succeeded but row not found: " + id));
    }

    public Optional<Job> findById(String orgId, String id) {
        return jdbi.onDemand(JobDao.class).findById(orgId, id).map(this::toDomain);
    }

    public List<Job> listByOrg(String orgId, int limit, int offset) {
        return jdbi.onDemand(JobDao.class).listByOrg(orgId, null, limit, offset).stream()
            .map(this::toDomain)
            .toList();
    }

    public List<Job> listByBenchmarkRun(String orgId, String benchmarkRunId, int limit, int offset) {
        return jdbi.onDemand(JobDao.class).listByOrg(orgId, benchmarkRunId, limit, offset).stream()
            .map(this::toDomain)
            .toList();
    }

    /**
     * Cancel a queued or running job. Returns the post-cancel snapshot,
     * or {@code Optional.empty()} when the job is already terminal +
     * cancellation is a no-op (caller maps to 404 / 409 as appropriate).
     */
    @Transactional
    public Optional<Job> cancel(String orgId, String id) {
        JobDao dao = jdbi.onDemand(JobDao.class);
        int updated = dao.cancel(orgId, id);
        return updated > 0 ? dao.findById(orgId, id).map(this::toDomain) : Optional.empty();
    }

    /**
     * Apply a status transition pushed back by a harness-server executing
     * a WORK job (W1d). Maps harness-server's status vocabulary to the
     * controlplane's {@link JobStatus}, then updates the row (the DAO
     * never regresses out of a terminal state). Returns the post-update
     * snapshot, or {@code Optional.empty()} when the job doesn't exist
     * (a no-op update on an already-terminal job still returns the
     * snapshot — not a 404).
     */
    @Transactional
    public Optional<Job> applyHarnessStatus(String orgId, String id, String harnessStatus, String failureReason) {
        JobStatus mapped = mapHarnessStatus(harnessStatus);
        JobDao dao = jdbi.onDemand(JobDao.class);
        dao.applyHarnessStatus(orgId, id, mapped.dbValue(), failureReason);
        return dao.findById(orgId, id).map(this::toDomain);
    }

    /** harness-server status string → controlplane {@link JobStatus}.
     *  The two paused sub-states ({@code awaiting-approval}, {@code suspended})
     *  fold to {@code running} — the controlplane has no equivalent; the
     *  HITL queue reads the paused detail from the ApprovalRequest, not
     *  the job status. */
    private static JobStatus mapHarnessStatus(String s) {
        return switch (s) {
            case "received", "queued" -> JobStatus.QUEUED;
            case "running", "awaiting-approval", "suspended" -> JobStatus.RUNNING;
            case "completed" -> JobStatus.COMPLETED;
            case "failed" -> JobStatus.FAILED;
            case "cancelling" -> JobStatus.CANCELLING;
            case "cancelled" -> JobStatus.CANCELLED;
            default -> throw new IllegalArgumentException("unknown harness job status: " + s);
        };
    }

    /**
     * Record a quality score for a job (slice 4 of the eval-harness).
     * The scorer is external — rubric runner / LLM-as-judge / manual
     * review — and posts via {@code POST /api/jobs/&#123;id&#125;/score}.
     * Returns the post-score Job snapshot or empty when the job is
     * missing.
     */
    @Transactional
    public Optional<Job> recordEvalScore(
        String orgId, String id,
        Double score, String rationale, String judge
    ) {
        JobDao dao = jdbi.onDemand(JobDao.class);
        int updated = dao.recordEvalScore(orgId, id, score, rationale, judge);
        return updated > 0 ? dao.findById(orgId, id).map(this::toDomain) : Optional.empty();
    }

    /**
     * Record a post-job reflection: actual story points, free-text retro,
     * optional structured surprises (JSON array). Posted via
     * {@code POST /api/jobs/&#123;id&#125;/reflection}. Surprises with
     * {@code kind: 'missing-skill'} are typically forwarded into the
     * SkillProposal queue by the controller orchestrating the call.
     */
    @Transactional
    public Optional<Job> recordReflection(
        String orgId, String id,
        Double actualPoints, String reflection, JsonNode surprises
    ) {
        JobDao dao = jdbi.onDemand(JobDao.class);
        int updated = dao.recordReflection(
            orgId, id, actualPoints, reflection, writeJson(surprises)
        );
        return updated > 0 ? dao.findById(orgId, id).map(this::toDomain) : Optional.empty();
    }

    /**
     * Deliver an external event payload to a paused {@code wait-for-event}
     * step. Validates the job is RUNNING and currently paused; re-engages
     * the engine via {@link JobEngine#resumeJob(Job, JsonNode)}.
     */
    public Optional<Job> deliverEvent(String orgId, String jobId, String eventName, JsonNode payload) {
        Job job = findById(orgId, jobId).orElse(null);
        if (job == null) return Optional.empty();
        if (job.status() != JobStatus.RUNNING || job.currentNodeId() == null) {
            throw new IllegalStateException(
                "job " + jobId + " is not paused (status=" + job.status() +
                ", currentNodeId=" + job.currentNodeId() + ")");
        }
        return Optional.of(jobEngine.resumeJob(job, payload != null ? payload : objectMapper.nullNode()));
    }

    /**
     * Submit an approval verdict to a paused {@code approval} step.
     * Verdict shape: {@code { "verdict": "approved" | "rejected", "reason"?, "approver"? }}.
     */
    public Optional<Job> submitApproval(String orgId, String jobId, String nodeId, JsonNode verdictPayload) {
        Job job = findById(orgId, jobId).orElse(null);
        if (job == null) return Optional.empty();
        if (job.status() != JobStatus.RUNNING || job.currentNodeId() == null) {
            throw new IllegalStateException(
                "job " + jobId + " is not paused (status=" + job.status() +
                ", currentNodeId=" + job.currentNodeId() + ")");
        }
        if (!job.currentNodeId().equals(nodeId)) {
            throw new IllegalStateException(
                "job " + jobId + " is paused at node " + job.currentNodeId() +
                ", not " + nodeId);
        }
        return Optional.of(jobEngine.resumeJob(job, verdictPayload));
    }

    // ── helpers ───────────────────────────────────────────────────────────

    private Job toDomain(JobDaoRow row) {
        return new Job(
            row.orgId(), row.id(), row.flowId(), row.productId(), row.status(),
            readJson(row.input()), row.setName(), readJson(row.config()),
            readJson(row.output()),
            row.failureReason(), row.currentNodeId(),
            row.benchmarkRunId(), row.benchmarkLabel(),
            row.evalScore(), row.evalRationale(), row.evalJudge(), row.evalScoredAt(),
            row.estimatedPoints(), row.actualPoints(), row.reflection(),
            readJson(row.surprises()), row.reflectedAt(),
            row.createdAt(), row.startedAt(), row.completedAt(),
            row.createdBy()
        );
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

package com.jefelabs.agentx.controlplane.job.service;

import com.jefelabs.agentx.controlplane.core.types.JobIntent;
import com.jefelabs.agentx.controlplane.job.domain.Job;
import com.jefelabs.agentx.controlplane.job.domain.JobStatus;
import com.jefelabs.agentx.controlplane.job.persistence.JobDao;
import com.jefelabs.agentx.controlplane.job.persistence.JobDaoRow;
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

    private final Jdbi jdbi;
    private final ObjectMapper objectMapper;

    public JobService(Jdbi jdbi, ObjectMapper objectMapper) {
        this.jdbi = jdbi;
        this.objectMapper = objectMapper;
    }

    /**
     * Materialize a {@link JobIntent} into a persisted {@link Job} in
     * {@link JobStatus#QUEUED} state. Phase 3b's engine picks up queued
     * jobs and walks the FlowDef from there.
     */
    @Transactional
    public Job submit(String orgId, String createdBy, JobIntent intent) {
        String id = "job-" + UUID.randomUUID();

        JobDao dao = jdbi.onDemand(JobDao.class);
        dao.insert(
            orgId, id,
            intent.flowId(), intent.productId(),
            JobStatus.QUEUED,
            writeJson(intent.input()),
            intent.set(),
            writeJson(intent.config()),
            createdBy
        );

        return dao.findById(orgId, id)
            .map(this::toDomain)
            .orElseThrow(() -> new IllegalStateException("Insert succeeded but row not found: " + id));
    }

    public Optional<Job> findById(String orgId, String id) {
        return jdbi.onDemand(JobDao.class).findById(orgId, id).map(this::toDomain);
    }

    public List<Job> listByOrg(String orgId, int limit, int offset) {
        return jdbi.onDemand(JobDao.class).listByOrg(orgId, limit, offset).stream()
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

    // ── helpers ───────────────────────────────────────────────────────────

    private Job toDomain(JobDaoRow row) {
        return new Job(
            row.orgId(), row.id(), row.flowId(), row.productId(), row.status(),
            readJson(row.input()), row.setName(), readJson(row.config()),
            readJson(row.output()),
            row.failureReason(), row.currentNodeId(),
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

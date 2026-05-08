package com.jefelabs.agentx.controlplane.context.service;

import com.jefelabs.agentx.controlplane.context.domain.ContextSource;
import com.jefelabs.agentx.controlplane.context.domain.IngestionJob;
import com.jefelabs.agentx.controlplane.context.persistence.ContextSourceDao;
import com.jefelabs.agentx.controlplane.context.persistence.ContextSourceDaoRow;
import com.jefelabs.agentx.controlplane.context.persistence.IngestionJobDao;
import org.jdbi.v3.core.Jdbi;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Optional;

/**
 * Context-source registry. Phase 4.1 ships CRUD only; ingestion subprocess
 * + Neo4j query land in Phase 4.2 + 4.3.
 */
@Service
public class ContextService {

    private final Jdbi jdbi;
    private final ObjectMapper objectMapper;

    public ContextService(Jdbi jdbi, ObjectMapper objectMapper) {
        this.jdbi = jdbi;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public ContextSource registerSource(ContextSource source) {
        ContextSourceDao dao = jdbi.onDemand(ContextSourceDao.class);
        dao.upsert(
            source.orgId(),
            source.id(),
            source.kind(),
            source.target(),
            source.profile(),
            source.refreshSchedule() != null ? source.refreshSchedule()
                : com.jefelabs.agentx.controlplane.context.domain.RefreshSchedule.MANUAL,
            writeJson(source.accessPolicy()),
            source.createdBy()
        );
        return dao.findById(source.orgId(), source.id())
            .map(this::toDomain)
            .orElseThrow(() -> new IllegalStateException("Upsert succeeded but row not found: " + source.id()));
    }

    public Optional<ContextSource> findById(String orgId, String id) {
        return jdbi.onDemand(ContextSourceDao.class).findById(orgId, id).map(this::toDomain);
    }

    public List<ContextSource> listByOrg(String orgId, int limit, int offset) {
        return jdbi.onDemand(ContextSourceDao.class).listByOrg(orgId, limit, offset).stream()
            .map(this::toDomain)
            .toList();
    }

    @Transactional
    public boolean softDelete(String orgId, String id) {
        return jdbi.onDemand(ContextSourceDao.class).softDelete(orgId, id) > 0;
    }

    public List<IngestionJob> listIngestionsBySource(String orgId, String sourceId, int limit) {
        return jdbi.onDemand(IngestionJobDao.class).listBySource(orgId, sourceId, limit).stream()
            .map(r -> new IngestionJob(
                r.id(), r.orgId(), r.sourceId(), r.status(),
                r.chunkCount(), r.failureReason(),
                r.createdAt(), r.startedAt(), r.completedAt()))
            .toList();
    }

    // ── helpers ───────────────────────────────────────────────────────────

    private ContextSource toDomain(ContextSourceDaoRow row) {
        return new ContextSource(
            row.orgId(), row.id(), row.kind(), row.target(),
            row.profile(), row.refreshSchedule(),
            readJson(row.accessPolicy()),
            row.createdAt(), row.updatedAt(), row.createdBy()
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

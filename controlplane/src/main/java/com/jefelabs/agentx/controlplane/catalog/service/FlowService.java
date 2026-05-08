package com.jefelabs.agentx.controlplane.catalog.service;

import com.jefelabs.agentx.controlplane.catalog.domain.Flow;
import com.jefelabs.agentx.controlplane.catalog.persistence.FlowDao;
import com.jefelabs.agentx.controlplane.catalog.persistence.FlowDaoRow;
import com.jefelabs.agentx.controlplane.catalog.sse.CatalogChangedEvent;
import org.jdbi.v3.core.Jdbi;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Optional;

/**
 * Catalog flow operations. Per layering convention
 * ({@code feedback_controller_service_layering.md}): receives only domain
 * types ({@link Flow}, primitives) — never DTOs. Controllers convert DTO →
 * domain via the MapStruct mapper before calling here.
 *
 * <p>Owns the JSONB ↔ {@link JsonNode} conversion at the persistence
 * boundary: {@link FlowDao} surfaces JSON columns as {@code String}, this
 * service parses them into {@code JsonNode} for the domain record (and
 * serializes back on writes). Keeps JDBI free of Jackson-version concerns.
 */
@Service
public class FlowService {

    private final Jdbi jdbi;
    private final ObjectMapper objectMapper;
    private final ApplicationEventPublisher events;

    public FlowService(Jdbi jdbi, ObjectMapper objectMapper, ApplicationEventPublisher events) {
        this.jdbi = jdbi;
        this.objectMapper = objectMapper;
        this.events = events;
    }

    @Transactional
    public Flow upsert(Flow flow) {
        FlowDao dao = jdbi.onDemand(FlowDao.class);
        dao.upsert(
            flow.orgId(),
            flow.id(),
            flow.description(),
            flow.kind(),
            writeJson(flow.output()),
            writeJson(flow.nodes()),
            writeJson(flow.edges()),
            flow.createdBy()
        );
        // Re-read so the response carries server-populated audit timestamps.
        Flow saved = dao.findById(flow.orgId(), flow.id())
            .map(this::toDomain)
            .orElseThrow(() -> new IllegalStateException("Upsert succeeded but row not found: " + flow.id()));
        events.publishEvent(new CatalogChangedEvent(flow.orgId(), "flow", flow.id(), "upsert"));
        return saved;
    }

    public Optional<Flow> findById(String orgId, String id) {
        return jdbi.onDemand(FlowDao.class).findById(orgId, id).map(this::toDomain);
    }

    public List<Flow> listByOrg(String orgId, int limit, int offset) {
        return jdbi.onDemand(FlowDao.class).listByOrg(orgId, limit, offset).stream()
            .map(this::toDomain)
            .toList();
    }

    @Transactional
    public boolean softDelete(String orgId, String id, String deletedBy) {
        boolean removed = jdbi.onDemand(FlowDao.class).softDelete(orgId, id, deletedBy) > 0;
        if (removed) events.publishEvent(new CatalogChangedEvent(orgId, "flow", id, "delete"));
        return removed;
    }

    // ── JSON conversion at the persistence boundary ───────────────────────

    private Flow toDomain(FlowDaoRow row) {
        return new Flow(
            row.orgId(),
            row.id(),
            row.description(),
            row.kind(),
            readJson(row.output()),
            readJson(row.nodes()),
            readJson(row.edges()),
            row.createdAt(),
            row.updatedAt(),
            row.createdBy(),
            row.updatedBy()
        );
    }

    private JsonNode readJson(String json) {
        if (json == null) return null;
        try {
            return objectMapper.readTree(json);
        } catch (JacksonException e) {
            throw new IllegalStateException("Stored JSON failed to parse — DB integrity issue", e);
        }
    }

    private String writeJson(JsonNode node) {
        if (node == null) return null;
        try {
            return objectMapper.writeValueAsString(node);
        } catch (JacksonException e) {
            throw new IllegalArgumentException("Failed to serialize JsonNode for storage", e);
        }
    }
}

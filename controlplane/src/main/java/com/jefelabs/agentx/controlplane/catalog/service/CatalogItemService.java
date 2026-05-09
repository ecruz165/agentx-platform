package com.jefelabs.agentx.controlplane.catalog.service;

import com.jefelabs.agentx.controlplane.catalog.domain.CatalogItem;
import com.jefelabs.agentx.controlplane.catalog.domain.CatalogItemType;
import com.jefelabs.agentx.controlplane.catalog.persistence.CatalogItemDao;
import com.jefelabs.agentx.controlplane.catalog.persistence.CatalogItemDaoRow;
import org.jdbi.v3.core.Jdbi;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Optional;

/**
 * Read + upsert API for the unified catalog. Skillzkit sync writes
 * here; agent-builder UIs read from here.
 */
@Service
public class CatalogItemService {

    private final Jdbi jdbi;
    private final ObjectMapper objectMapper;

    public CatalogItemService(Jdbi jdbi, ObjectMapper objectMapper) {
        this.jdbi = jdbi;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public CatalogItem upsert(CatalogItem item) {
        CatalogItemDao dao = jdbi.onDemand(CatalogItemDao.class);
        String[] tagsArr = item.tags() != null ? item.tags().toArray(String[]::new) : new String[0];
        dao.upsert(
            item.orgId(), item.type(), item.id(),
            item.name(), item.version(), item.description(),
            item.topic(), tagsArr, item.runtime(),
            writeJson(item.manifest()),
            item.source() != null ? item.source() : "skillzkit"
        );
        return dao.findById(item.orgId(), item.type(), item.id())
            .map(this::toDomain)
            .orElseThrow(() -> new IllegalStateException(
                "Upsert succeeded but row not found: " + item.type() + "/" + item.id()));
    }

    public Optional<CatalogItem> findById(String orgId, CatalogItemType type, String id) {
        return jdbi.onDemand(CatalogItemDao.class).findById(orgId, type, id).map(this::toDomain);
    }

    public List<CatalogItem> listByOrg(String orgId, CatalogItemType type, int limit, int offset) {
        return jdbi.onDemand(CatalogItemDao.class).listByOrg(orgId, type, limit, offset).stream()
            .map(this::toDomain)
            .toList();
    }

    public long countByOrg(String orgId) {
        return jdbi.onDemand(CatalogItemDao.class).countByOrg(orgId);
    }

    /**
     * Soft-delete a catalog item. Used when an upstream source-of-truth
     * (currently: skillzkit) tells us a draft we seeded locally should
     * be retired in favor of the canonical version that's about to land
     * via the next agentx-load sync. The row stays for audit; the next
     * agentx-load can resurrect it via upsert if skillzkit ships the
     * same id.
     */
    @Transactional
    public boolean softDelete(String orgId, CatalogItemType type, String id) {
        return jdbi.onDemand(CatalogItemDao.class).softDelete(orgId, type, id) > 0;
    }

    // ── helpers ───────────────────────────────────────────────────────────

    private CatalogItem toDomain(CatalogItemDaoRow row) {
        return new CatalogItem(
            row.orgId(), row.type(), row.id(), row.name(),
            row.version(), row.description(), row.topic(),
            row.tags() != null ? List.of(row.tags()) : List.of(),
            row.runtime(), readJson(row.manifest()),
            row.source(), row.createdAt(), row.updatedAt()
        );
    }

    private JsonNode readJson(String json) {
        if (json == null) return null;
        try { return objectMapper.readTree(json); }
        catch (JacksonException e) { throw new IllegalStateException("Stored JSON parse failed", e); }
    }

    private String writeJson(JsonNode node) {
        if (node == null) return "null";
        try { return objectMapper.writeValueAsString(node); }
        catch (JacksonException e) { throw new IllegalArgumentException("Failed to serialize JsonNode", e); }
    }
}

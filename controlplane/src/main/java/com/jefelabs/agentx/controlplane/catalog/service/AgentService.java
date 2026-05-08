package com.jefelabs.agentx.controlplane.catalog.service;

import com.jefelabs.agentx.controlplane.catalog.domain.Agent;
import com.jefelabs.agentx.controlplane.catalog.persistence.AgentDao;
import com.jefelabs.agentx.controlplane.catalog.persistence.AgentDaoRow;
import org.jdbi.v3.core.Jdbi;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Optional;

/**
 * Catalog agent operations. Same shape as {@link FlowService}: receives only
 * domain types; owns the JSONB ↔ {@link JsonNode} conversion at the
 * persistence boundary.
 */
@Service
public class AgentService {

    private final Jdbi jdbi;
    private final ObjectMapper objectMapper;

    public AgentService(Jdbi jdbi, ObjectMapper objectMapper) {
        this.jdbi = jdbi;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public Agent upsert(Agent agent) {
        AgentDao dao = jdbi.onDemand(AgentDao.class);
        dao.upsert(
            agent.orgId(),
            agent.id(),
            agent.role(),
            agent.adapter(),
            agent.systemPrompt(),
            writeJson(agent.config()),
            writeJson(agent.accepts()),
            writeJson(agent.fallbackOn()),
            writeJson(agent.skillz()),
            agent.createdBy()
        );
        return dao.findById(agent.orgId(), agent.id())
            .map(this::toDomain)
            .orElseThrow(() -> new IllegalStateException("Upsert succeeded but row not found: " + agent.id()));
    }

    public Optional<Agent> findById(String orgId, String id) {
        return jdbi.onDemand(AgentDao.class).findById(orgId, id).map(this::toDomain);
    }

    public List<Agent> listByOrg(String orgId, int limit, int offset) {
        return jdbi.onDemand(AgentDao.class).listByOrg(orgId, limit, offset).stream()
            .map(this::toDomain)
            .toList();
    }

    @Transactional
    public boolean softDelete(String orgId, String id, String deletedBy) {
        return jdbi.onDemand(AgentDao.class).softDelete(orgId, id, deletedBy) > 0;
    }

    // ── JSON conversion at the persistence boundary ───────────────────────

    private Agent toDomain(AgentDaoRow row) {
        return new Agent(
            row.orgId(),
            row.id(),
            row.role(),
            row.adapter(),
            row.systemPrompt(),
            readJson(row.config()),
            readJson(row.accepts()),
            readJson(row.fallbackOn()),
            readJson(row.skillz()),
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

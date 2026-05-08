package com.jefelabs.agentx.controlplane.catalog.service;

import com.jefelabs.agentx.controlplane.catalog.domain.Skill;
import com.jefelabs.agentx.controlplane.catalog.persistence.SkillDao;
import com.jefelabs.agentx.controlplane.catalog.persistence.SkillDaoRow;
import org.jdbi.v3.core.Jdbi;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Optional;

@Service
public class SkillService {

    private final Jdbi jdbi;
    private final ObjectMapper objectMapper;

    public SkillService(Jdbi jdbi, ObjectMapper objectMapper) {
        this.jdbi = jdbi;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public Skill upsert(Skill skill) {
        SkillDao dao = jdbi.onDemand(SkillDao.class);
        dao.upsert(
            skill.orgId(),
            skill.id(),
            skill.category(),
            skill.description(),
            writeJson(skill.metadata()),
            skill.createdBy()
        );
        return dao.findById(skill.orgId(), skill.id())
            .map(this::toDomain)
            .orElseThrow(() -> new IllegalStateException("Upsert succeeded but row not found: " + skill.id()));
    }

    public Optional<Skill> findById(String orgId, String id) {
        return jdbi.onDemand(SkillDao.class).findById(orgId, id).map(this::toDomain);
    }

    public List<Skill> listByOrg(String orgId, int limit, int offset) {
        return jdbi.onDemand(SkillDao.class).listByOrg(orgId, limit, offset).stream()
            .map(this::toDomain)
            .toList();
    }

    @Transactional
    public boolean softDelete(String orgId, String id, String deletedBy) {
        return jdbi.onDemand(SkillDao.class).softDelete(orgId, id, deletedBy) > 0;
    }

    private Skill toDomain(SkillDaoRow row) {
        return new Skill(
            row.orgId(), row.id(), row.category(), row.description(),
            readJson(row.metadata()),
            row.createdAt(), row.updatedAt(), row.createdBy(), row.updatedBy()
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

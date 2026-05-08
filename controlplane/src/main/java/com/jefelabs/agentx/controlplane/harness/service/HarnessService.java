package com.jefelabs.agentx.controlplane.harness.service;

import com.jefelabs.agentx.controlplane.harness.domain.Harness;
import com.jefelabs.agentx.controlplane.harness.domain.HarnessStatus;
import com.jefelabs.agentx.controlplane.harness.persistence.HarnessDao;
import com.jefelabs.agentx.controlplane.harness.persistence.HarnessDaoRow;
import org.jdbi.v3.core.Jdbi;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.security.SecureRandom;
import java.util.Base64;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Harness registration + heartbeat operations. Per layering convention:
 * receives only domain types; owns the JsonNode ↔ JSON-String conversion
 * at the persistence boundary; generates session tokens for new
 * registrations.
 *
 * <p>Phase 2 MVP: session token is a 32-byte random URL-safe string.
 * Phase 7 replaces with signed/scoped JWT-or-equivalent per
 * prd-control-plane-operational-hardening.md §6.3.
 */
@Service
public class HarnessService {

    private static final SecureRandom RANDOM = new SecureRandom();

    private final Jdbi jdbi;
    private final ObjectMapper objectMapper;

    public HarnessService(Jdbi jdbi, ObjectMapper objectMapper) {
        this.jdbi = jdbi;
        this.objectMapper = objectMapper;
    }

    /**
     * Register a new harness or re-register an existing one (caller-supplied id).
     * Returns a record carrying the (possibly server-assigned) id, the new
     * session token, and the current persisted Harness state.
     */
    @Transactional
    public Registration register(
        String orgId,
        String suppliedId,
        String name,
        String version,
        String region,
        JsonNode capabilities,
        JsonNode endpoints
    ) {
        String id = (suppliedId != null && !suppliedId.isBlank()) ? suppliedId : "harness-" + UUID.randomUUID();
        String sessionToken = newSessionToken();

        HarnessDao dao = jdbi.onDemand(HarnessDao.class);
        dao.registerOrUpdate(
            orgId, id, name, version,
            HarnessStatus.REGISTERED,
            region,
            writeJson(capabilities != null ? capabilities : objectMapper.createObjectNode()),
            writeJson(endpoints    != null ? endpoints    : objectMapper.createObjectNode()),
            sessionToken
        );

        Harness persisted = dao.findById(orgId, id)
            .map(this::toDomain)
            .orElseThrow(() -> new IllegalStateException("Register succeeded but row not found: " + id));

        return new Registration(id, sessionToken, persisted);
    }

    @Transactional
    public Optional<Harness> recordHeartbeat(String orgId, String id, String sessionToken, Integer currentLoad) {
        HarnessDao dao = jdbi.onDemand(HarnessDao.class);
        int updated = dao.recordHeartbeat(orgId, id, sessionToken, currentLoad);
        return updated > 0 ? dao.findById(orgId, id).map(this::toDomain) : Optional.empty();
    }

    public Optional<Harness> findById(String orgId, String id) {
        return jdbi.onDemand(HarnessDao.class).findById(orgId, id).map(this::toDomain);
    }

    public List<Harness> listActiveByOrg(String orgId, int limit, int offset) {
        return jdbi.onDemand(HarnessDao.class).listActiveByOrg(orgId, limit, offset).stream()
            .map(this::toDomain)
            .toList();
    }

    @Transactional
    public boolean deregister(String orgId, String id) {
        return jdbi.onDemand(HarnessDao.class).markDisconnected(orgId, id) > 0;
    }

    public record Registration(String harnessId, String sessionToken, Harness harness) {}

    // ── helpers ───────────────────────────────────────────────────────────

    private Harness toDomain(HarnessDaoRow row) {
        return new Harness(
            row.orgId(), row.id(), row.name(), row.version(), row.status(), row.region(),
            readJson(row.capabilities()), readJson(row.endpoints()),
            row.currentLoad(), row.sessionToken(),
            row.lastHeartbeatAt(), row.registeredAt(), row.updatedAt()
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

    private static String newSessionToken() {
        byte[] buf = new byte[32];
        RANDOM.nextBytes(buf);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(buf);
    }
}

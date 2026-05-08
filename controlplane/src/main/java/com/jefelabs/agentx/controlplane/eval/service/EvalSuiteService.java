package com.jefelabs.agentx.controlplane.eval.service;

import com.jefelabs.agentx.controlplane.core.types.JobIntent;
import com.jefelabs.agentx.controlplane.eval.domain.EvalSuite;
import com.jefelabs.agentx.controlplane.eval.persistence.EvalSuiteDao;
import com.jefelabs.agentx.controlplane.eval.persistence.EvalSuiteDaoRow;
import com.jefelabs.agentx.controlplane.job.domain.Job;
import com.jefelabs.agentx.controlplane.job.service.JobService;
import org.jdbi.v3.core.Jdbi;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Eval-suite CRUD + run-submission. {@code run(suiteId, …)} loops over
 * the suite's inputs and submits one job per input with shared
 * {@code benchmark.runId} + {@code label} so all the resulting jobs
 * are correlated for compare.
 */
@Service
public class EvalSuiteService {

    private final Jdbi jdbi;
    private final ObjectMapper objectMapper;
    private final JobService jobService;

    public EvalSuiteService(Jdbi jdbi, ObjectMapper objectMapper, JobService jobService) {
        this.jdbi = jdbi;
        this.objectMapper = objectMapper;
        this.jobService = jobService;
    }

    @Transactional
    public EvalSuite upsert(EvalSuite suite) {
        EvalSuiteDao dao = jdbi.onDemand(EvalSuiteDao.class);
        dao.upsert(
            suite.orgId(), suite.id(), suite.name(), suite.description(),
            writeJson(suite.inputs() != null ? suite.inputs() : objectMapper.createArrayNode()),
            suite.createdBy()
        );
        return dao.findById(suite.orgId(), suite.id())
            .map(this::toDomain)
            .orElseThrow(() -> new IllegalStateException("Upsert succeeded but row missing: " + suite.id()));
    }

    public Optional<EvalSuite> findById(String orgId, String id) {
        return jdbi.onDemand(EvalSuiteDao.class).findById(orgId, id).map(this::toDomain);
    }

    public List<EvalSuite> listByOrg(String orgId, int limit, int offset) {
        return jdbi.onDemand(EvalSuiteDao.class).listByOrg(orgId, limit, offset).stream()
            .map(this::toDomain)
            .toList();
    }

    @Transactional
    public boolean softDelete(String orgId, String id) {
        return jdbi.onDemand(EvalSuiteDao.class).softDelete(orgId, id) > 0;
    }

    /**
     * Submit one job per element in the suite's {@code inputs} array,
     * tagged with a shared {@code benchmark.runId}. Returns the runId
     * + the list of submitted jobIds. Non-array {@code inputs} → empty
     * run with zero jobs (defensive; CHECK constraint should prevent
     * this in practice).
     */
    @Transactional
    public RunResult run(
        String orgId, String userId, String suiteId,
        String flowId, String productId,
        String label, JsonNode configOverrides
    ) {
        EvalSuite suite = findById(orgId, suiteId)
            .orElseThrow(() -> new IllegalArgumentException("Eval suite not found: " + suiteId));

        if (suite.inputs() == null || !suite.inputs().isArray()) {
            return new RunResult(newRunId(), label, List.of());
        }

        String runId = newRunId();
        List<String> jobIds = new ArrayList<>();
        for (JsonNode input : suite.inputs()) {
            JsonNode config = mergeConfig(configOverrides, runId, label);
            JobIntent intent = new JobIntent(flowId, productId, input, null, config);
            Job job = jobService.submit(orgId, userId, intent);
            jobIds.add(job.id());
        }
        return new RunResult(runId, label, jobIds);
    }

    public record RunResult(String runId, String label, List<String> jobIds) {}

    // ── helpers ───────────────────────────────────────────────────────────

    private JsonNode mergeConfig(JsonNode overrides, String runId, String label) {
        var node = (overrides != null && overrides.isObject())
            ? objectMapper.valueToTree(overrides).deepCopy()
            : objectMapper.createObjectNode();
        var bench = objectMapper.createObjectNode();
        bench.put("runId", runId);
        if (label != null) bench.put("label", label);
        ((tools.jackson.databind.node.ObjectNode) node).set("benchmark", bench);
        return node;
    }

    private static String newRunId() {
        return "run-" + UUID.randomUUID();
    }

    private EvalSuite toDomain(EvalSuiteDaoRow row) {
        return new EvalSuite(
            row.orgId(), row.id(), row.name(), row.description(),
            readJson(row.inputs()),
            row.createdAt(), row.updatedAt(), row.createdBy()
        );
    }

    private JsonNode readJson(String json) {
        if (json == null) return null;
        try { return objectMapper.readTree(json); }
        catch (JacksonException e) { throw new IllegalStateException("Stored JSON parse failed", e); }
    }

    private String writeJson(JsonNode node) {
        if (node == null) return "[]";
        try { return objectMapper.writeValueAsString(node); }
        catch (JacksonException e) { throw new IllegalArgumentException("Failed to serialize JsonNode", e); }
    }
}

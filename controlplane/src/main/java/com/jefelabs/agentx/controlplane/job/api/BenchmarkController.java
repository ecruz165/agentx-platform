package com.jefelabs.agentx.controlplane.job.api;

import com.jefelabs.agentx.controlplane.core.tenancy.TenantContext;
import com.jefelabs.agentx.controlplane.job.api.dto.BenchmarkRunSummaryDTO;
import com.jefelabs.agentx.controlplane.job.persistence.BenchmarkRunSummaryRow;
import com.jefelabs.agentx.controlplane.job.persistence.JobDao;
import org.jdbi.v3.core.Jdbi;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * Benchmark cohort comparison API. {@code GET /api/benchmarks/compare?runIds=A,B,C}
 * returns one summary row per run id — counts by terminal state plus
 * latency percentiles — so callers can lay them out side-by-side.
 *
 * <p>Slice 1+2 of the eval-harness work. Slice 3 (test-suite fixtures
 * + workspace-cli bench command) and slice 4 (LLM-as-judge quality
 * scoring) layer on top: the schema + endpoint here stay stable; the
 * future scoring lives on individual job records.
 */
@RestController
@RequestMapping("/api/benchmarks")
public class BenchmarkController {

    private final Jdbi jdbi;

    public BenchmarkController(Jdbi jdbi) {
        this.jdbi = jdbi;
    }

    @GetMapping("/compare")
    public List<BenchmarkRunSummaryDTO> compare(@RequestParam("runIds") List<String> runIds) {
        var orgId = TenantContext.current().orgId();
        JobDao dao = jdbi.onDemand(JobDao.class);
        return runIds.stream()
            .map(String::trim)
            .filter(s -> !s.isEmpty())
            .distinct()
            .map(runId -> {
                BenchmarkRunSummaryRow row = dao.summarizeBenchmarkRun(orgId, runId)
                    .orElse(emptyRow(runId));
                return toDTO(runId, row);
            })
            .toList();
    }

    private static BenchmarkRunSummaryRow emptyRow(String runId) {
        return new BenchmarkRunSummaryRow(0, 0, 0, 0, 0, runId, 0L, 0L);
    }

    private static BenchmarkRunSummaryDTO toDTO(String runId, BenchmarkRunSummaryRow row) {
        double successRate = row.total() == 0
            ? 0.0
            : (double) row.completed() / (double) row.total();
        return new BenchmarkRunSummaryDTO(
            runId, row.label(),
            row.total(), row.completed(), row.failed(), row.inFlight(), row.cancelled(),
            row.p50LatencyMs(), row.p95LatencyMs(),
            successRate
        );
    }
}

package com.jefelabs.agentx.controlplane.job.persistence;

import com.jefelabs.agentx.controlplane.job.domain.JobStatus;
import org.jdbi.v3.sqlobject.config.RegisterConstructorMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;
import java.util.Optional;

@RegisterConstructorMapper(JobDaoRow.class)
public interface JobDao {

    @SqlUpdate("""
        INSERT INTO jobs (org_id, id, flow_id, product_id, status,
                          input, set_name, config,
                          benchmark_run_id, benchmark_label,
                          created_by)
        VALUES (:orgId, :id, :flowId, :productId, :status,
                :input::jsonb, :setName, :config::jsonb,
                :benchmarkRunId, :benchmarkLabel,
                :createdBy)
    """)
    void insert(
        @Bind("orgId") String orgId,
        @Bind("id") String id,
        @Bind("flowId") String flowId,
        @Bind("productId") String productId,
        @Bind("status") JobStatus status,
        @Bind("input") String input,
        @Bind("setName") String setName,
        @Bind("config") String config,
        @Bind("benchmarkRunId") String benchmarkRunId,
        @Bind("benchmarkLabel") String benchmarkLabel,
        @Bind("createdBy") String createdBy
    );

    @SqlQuery("""
        SELECT org_id, id, flow_id, product_id, status,
               input::jsonb::text  AS input,
               set_name,
               config::jsonb::text AS config,
               output::jsonb::text AS output,
               failure_reason, current_node_id,
               benchmark_run_id, benchmark_label,
               created_at, started_at, completed_at, created_by
          FROM jobs
         WHERE org_id = :orgId AND id = :id
    """)
    Optional<JobDaoRow> findById(@Bind("orgId") String orgId, @Bind("id") String id);

    @SqlQuery("""
        SELECT org_id, id, flow_id, product_id, status,
               input::jsonb::text  AS input,
               set_name,
               config::jsonb::text AS config,
               output::jsonb::text AS output,
               failure_reason, current_node_id,
               benchmark_run_id, benchmark_label,
               created_at, started_at, completed_at, created_by
          FROM jobs
         WHERE org_id = :orgId
           AND (:benchmarkRunId IS NULL OR benchmark_run_id = :benchmarkRunId)
         ORDER BY created_at DESC
         LIMIT :limit OFFSET :offset
    """)
    List<JobDaoRow> listByOrg(
        @Bind("orgId") String orgId,
        @Bind("benchmarkRunId") String benchmarkRunId,
        @Bind("limit") int limit,
        @Bind("offset") int offset
    );

    /**
     * Aggregate metrics for a single benchmark run. Used by
     * {@code GET /api/benchmarks/compare} to fold a cohort into one
     * row per run for side-by-side display.
     *
     * <p>Latency is in milliseconds; uses {@code completed_at - started_at}
     * for terminal jobs, NULL otherwise. The percentile_cont aggregates
     * skip NULLs naturally so in-flight jobs don't pollute the values.
     */
    @SqlQuery("""
        SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE status IN ('queued','running','cancelling'))::int AS in_flight,
            COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
            COALESCE(MIN(benchmark_label), :runId) AS label,
            COALESCE(
                EXTRACT(EPOCH FROM percentile_cont(0.5) WITHIN GROUP (
                    ORDER BY (completed_at - started_at)
                ))::bigint * 1000,
                0
            ) AS p50_latency_ms,
            COALESCE(
                EXTRACT(EPOCH FROM percentile_cont(0.95) WITHIN GROUP (
                    ORDER BY (completed_at - started_at)
                ))::bigint * 1000,
                0
            ) AS p95_latency_ms
          FROM jobs
         WHERE org_id = :orgId AND benchmark_run_id = :runId
    """)
    @org.jdbi.v3.sqlobject.config.RegisterConstructorMapper(BenchmarkRunSummaryRow.class)
    Optional<BenchmarkRunSummaryRow> summarizeBenchmarkRun(
        @Bind("orgId") String orgId,
        @Bind("runId") String runId
    );

    /**
     * Conditional cancel — only transitions the row when the current status
     * allows it (queued → cancelled directly; running → cancelling). The
     * UPDATE returns 0 if the job is already terminal; service maps that
     * to "no-op" or 404.
     */
    @SqlUpdate("""
        UPDATE jobs SET
            status       = CASE WHEN status = 'running' THEN 'cancelling'::text
                                ELSE 'cancelled'::text END,
            completed_at = CASE WHEN status = 'queued' THEN CURRENT_TIMESTAMP
                                ELSE completed_at END
         WHERE org_id = :orgId AND id = :id
           AND status IN ('queued', 'running')
    """)
    int cancel(@Bind("orgId") String orgId, @Bind("id") String id);

    @SqlUpdate("""
        UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
         WHERE org_id = :orgId AND id = :id AND status = 'queued'
    """)
    int markRunning(@Bind("orgId") String orgId, @Bind("id") String id);

    @SqlUpdate("""
        UPDATE jobs SET status = 'completed', output = :output::jsonb, completed_at = CURRENT_TIMESTAMP
         WHERE org_id = :orgId AND id = :id AND status NOT IN ('completed', 'failed', 'cancelled')
    """)
    int markCompleted(@Bind("orgId") String orgId, @Bind("id") String id, @Bind("output") String output);

    @SqlUpdate("""
        UPDATE jobs SET status = 'failed', failure_reason = :reason, completed_at = CURRENT_TIMESTAMP
         WHERE org_id = :orgId AND id = :id AND status NOT IN ('completed', 'failed', 'cancelled')
    """)
    int markFailed(@Bind("orgId") String orgId, @Bind("id") String id, @Bind("reason") String reason);

    @SqlUpdate("""
        UPDATE jobs SET current_node_id = :nodeId
         WHERE org_id = :orgId AND id = :id AND status = 'running'
    """)
    int setCurrentNode(@Bind("orgId") String orgId, @Bind("id") String id, @Bind("nodeId") String nodeId);
}

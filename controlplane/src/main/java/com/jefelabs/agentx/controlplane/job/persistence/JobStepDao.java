package com.jefelabs.agentx.controlplane.job.persistence;

import com.jefelabs.agentx.controlplane.job.domain.StepStatus;
import org.jdbi.v3.sqlobject.config.RegisterConstructorMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;

@RegisterConstructorMapper(JobStepDaoRow.class)
public interface JobStepDao {

    @SqlUpdate("""
        INSERT INTO job_steps (org_id, job_id, node_id, attempt, status,
                               harness_id, input, started_at)
        VALUES (:orgId, :jobId, :nodeId, :attempt, :status,
                :harnessId, :input::jsonb, CURRENT_TIMESTAMP)
        ON CONFLICT (org_id, job_id, node_id, attempt) DO UPDATE SET
            status     = EXCLUDED.status,
            harness_id = EXCLUDED.harness_id,
            input      = EXCLUDED.input,
            started_at = EXCLUDED.started_at
    """)
    void startStep(
        @Bind("orgId") String orgId,
        @Bind("jobId") String jobId,
        @Bind("nodeId") String nodeId,
        @Bind("attempt") int attempt,
        @Bind("status") StepStatus status,
        @Bind("harnessId") String harnessId,
        @Bind("input") String input
    );

    @SqlUpdate("""
        UPDATE job_steps SET
            status         = :status,
            output         = :output::jsonb,
            failure_reason = :failureReason,
            completed_at   = CURRENT_TIMESTAMP
         WHERE org_id = :orgId AND job_id = :jobId AND node_id = :nodeId
           AND attempt = :attempt
    """)
    int completeStep(
        @Bind("orgId") String orgId,
        @Bind("jobId") String jobId,
        @Bind("nodeId") String nodeId,
        @Bind("attempt") int attempt,
        @Bind("status") StepStatus status,
        @Bind("output") String output,
        @Bind("failureReason") String failureReason
    );

    @SqlQuery("""
        SELECT org_id, job_id, node_id, attempt, status, harness_id,
               input::jsonb::text  AS input,
               output::jsonb::text AS output,
               failure_reason, started_at, completed_at
          FROM job_steps
         WHERE org_id = :orgId AND job_id = :jobId
         ORDER BY started_at ASC NULLS LAST, attempt ASC
    """)
    List<JobStepDaoRow> listByJob(@Bind("orgId") String orgId, @Bind("jobId") String jobId);
}

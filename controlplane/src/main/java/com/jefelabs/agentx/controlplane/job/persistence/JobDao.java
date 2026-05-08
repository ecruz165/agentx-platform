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
                          input, set_name, config, created_by)
        VALUES (:orgId, :id, :flowId, :productId, :status,
                :input::jsonb, :setName, :config::jsonb, :createdBy)
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
        @Bind("createdBy") String createdBy
    );

    @SqlQuery("""
        SELECT org_id, id, flow_id, product_id, status,
               input::jsonb::text  AS input,
               set_name,
               config::jsonb::text AS config,
               output::jsonb::text AS output,
               failure_reason, current_node_id,
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
               created_at, started_at, completed_at, created_by
          FROM jobs
         WHERE org_id = :orgId
         ORDER BY created_at DESC
         LIMIT :limit OFFSET :offset
    """)
    List<JobDaoRow> listByOrg(
        @Bind("orgId") String orgId,
        @Bind("limit") int limit,
        @Bind("offset") int offset
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
}

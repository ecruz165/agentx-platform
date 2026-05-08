package com.jefelabs.agentx.controlplane.intent.persistence;

import com.jefelabs.agentx.controlplane.intent.domain.SessionStatus;
import org.jdbi.v3.sqlobject.config.RegisterConstructorMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.statement.GetGeneratedKeys;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@RegisterConstructorMapper(SessionDaoRow.class)
public interface SessionDao {

    @SqlUpdate("""
        INSERT INTO intent_sessions
            (org_id, user_id, intake_pipeline_id, intake_job_id, status)
        VALUES
            (:orgId, :userId, :intakePipelineId, :intakeJobId, :status)
    """)
    @GetGeneratedKeys("id")
    UUID create(
        @Bind("orgId") String orgId,
        @Bind("userId") String userId,
        @Bind("intakePipelineId") String intakePipelineId,
        @Bind("intakeJobId") String intakeJobId,
        @Bind("status") SessionStatus status
    );

    @SqlQuery("""
        SELECT id, org_id, user_id, intake_pipeline_id, intake_job_id,
               work_job_id, status, resolved_intent::text AS resolved_intent,
               failure_reason, created_at, last_activity_at
          FROM intent_sessions
         WHERE org_id = :orgId AND id = :id
    """)
    Optional<SessionDaoRow> findById(
        @Bind("orgId") String orgId,
        @Bind("id") UUID id
    );

    @SqlQuery("""
        SELECT id, org_id, user_id, intake_pipeline_id, intake_job_id,
               work_job_id, status, resolved_intent::text AS resolved_intent,
               failure_reason, created_at, last_activity_at
          FROM intent_sessions
         WHERE org_id = :orgId
         ORDER BY created_at DESC
         LIMIT :limit OFFSET :offset
    """)
    List<SessionDaoRow> listByOrg(
        @Bind("orgId") String orgId,
        @Bind("limit") int limit,
        @Bind("offset") int offset
    );

    /**
     * Auth-as-SQL-predicate: only transitions when current status is in the
     * expected set, preventing illegal transitions even under concurrent
     * requests. Returns rows-affected so callers can map to 404/409.
     */
    @SqlUpdate("""
        UPDATE intent_sessions
           SET status = :newStatus,
               last_activity_at = NOW()
         WHERE org_id = :orgId AND id = :id
           AND status IN (<allowedStatuses>)
    """)
    int transitionStatus(
        @Bind("orgId") String orgId,
        @Bind("id") UUID id,
        @Bind("newStatus") SessionStatus newStatus,
        @org.jdbi.v3.sqlobject.customizer.BindList("allowedStatuses") List<String> allowedStatuses
    );

    @SqlUpdate("""
        UPDATE intent_sessions
           SET work_job_id = :workJobId,
               resolved_intent = :resolvedIntent::jsonb,
               status = 'submitted',
               last_activity_at = NOW()
         WHERE org_id = :orgId AND id = :id
           AND status NOT IN ('submitted', 'aborted', 'expired')
    """)
    int markSubmitted(
        @Bind("orgId") String orgId,
        @Bind("id") UUID id,
        @Bind("workJobId") String workJobId,
        @Bind("resolvedIntent") String resolvedIntent
    );
}

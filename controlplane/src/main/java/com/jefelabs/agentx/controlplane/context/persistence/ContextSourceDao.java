package com.jefelabs.agentx.controlplane.context.persistence;

import com.jefelabs.agentx.controlplane.context.domain.RefreshSchedule;
import com.jefelabs.agentx.controlplane.context.domain.SourceKind;
import org.jdbi.v3.sqlobject.config.RegisterConstructorMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;
import java.util.Optional;

@RegisterConstructorMapper(ContextSourceDaoRow.class)
public interface ContextSourceDao {

    @SqlUpdate("""
        INSERT INTO context_sources (org_id, id, kind, target, profile,
                                      refresh_schedule, access_policy, created_by)
        VALUES (:orgId, :id, :kind, :target, :profile,
                :refreshSchedule, :accessPolicy::jsonb, :createdBy)
        ON CONFLICT (org_id, id) DO UPDATE SET
            kind             = EXCLUDED.kind,
            target           = EXCLUDED.target,
            profile          = EXCLUDED.profile,
            refresh_schedule = EXCLUDED.refresh_schedule,
            access_policy    = EXCLUDED.access_policy,
            updated_at       = CURRENT_TIMESTAMP,
            deleted_at       = NULL
    """)
    void upsert(
        @Bind("orgId") String orgId,
        @Bind("id") String id,
        @Bind("kind") SourceKind kind,
        @Bind("target") String target,
        @Bind("profile") String profile,
        @Bind("refreshSchedule") RefreshSchedule refreshSchedule,
        @Bind("accessPolicy") String accessPolicy,
        @Bind("createdBy") String createdBy
    );

    @SqlQuery("""
        SELECT org_id, id, kind, target, profile, refresh_schedule,
               access_policy::text AS access_policy,
               created_at, updated_at, created_by
          FROM context_sources
         WHERE org_id = :orgId AND id = :id AND deleted_at IS NULL
    """)
    Optional<ContextSourceDaoRow> findById(@Bind("orgId") String orgId, @Bind("id") String id);

    @SqlQuery("""
        SELECT org_id, id, kind, target, profile, refresh_schedule,
               access_policy::text AS access_policy,
               created_at, updated_at, created_by
          FROM context_sources
         WHERE org_id = :orgId AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT :limit OFFSET :offset
    """)
    List<ContextSourceDaoRow> listByOrg(
        @Bind("orgId") String orgId,
        @Bind("limit") int limit,
        @Bind("offset") int offset
    );

    @SqlUpdate("""
        UPDATE context_sources SET deleted_at = CURRENT_TIMESTAMP
         WHERE org_id = :orgId AND id = :id AND deleted_at IS NULL
    """)
    int softDelete(@Bind("orgId") String orgId, @Bind("id") String id);

    /**
     * Phase 4.4 — sources whose cadence has elapsed and which have no
     * pending/running ingestion. Encodes both the freshness comparison and
     * the in-flight exclusion as SQL predicates so the poller does one
     * round trip and never double-triggers (any concurrent tick would re-run
     * the same predicate and find these sources have a pending job).
     *
     * <p>Daily/weekly intervals are passed as seconds so callers (tests,
     * dev profiles) can override the cadence without changing schema.
     */
    @SqlQuery("""
        SELECT cs.org_id, cs.id, cs.kind, cs.target, cs.profile, cs.refresh_schedule,
               cs.access_policy::text AS access_policy,
               cs.created_at, cs.updated_at, cs.created_by
          FROM context_sources cs
          LEFT JOIN LATERAL (
            SELECT MAX(completed_at) AS last_completed
              FROM ingestion_jobs ij
             WHERE ij.org_id = cs.org_id
               AND ij.source_id = cs.id
               AND ij.status = 'completed'
          ) last_ij ON TRUE
         WHERE cs.deleted_at IS NULL
           AND cs.refresh_schedule IN ('daily', 'weekly')
           AND (last_ij.last_completed IS NULL
             OR last_ij.last_completed < NOW() - (
                CASE cs.refresh_schedule
                  WHEN 'daily'  THEN make_interval(secs => :dailySeconds)
                  WHEN 'weekly' THEN make_interval(secs => :weeklySeconds)
                END))
           AND NOT EXISTS (
             SELECT 1 FROM ingestion_jobs ij2
              WHERE ij2.org_id = cs.org_id
                AND ij2.source_id = cs.id
                AND ij2.status IN ('pending', 'running')
           )
         ORDER BY cs.created_at
    """)
    List<ContextSourceDaoRow> findDueForRefresh(
        @Bind("dailySeconds") long dailySeconds,
        @Bind("weeklySeconds") long weeklySeconds
    );
}

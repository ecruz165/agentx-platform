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
}

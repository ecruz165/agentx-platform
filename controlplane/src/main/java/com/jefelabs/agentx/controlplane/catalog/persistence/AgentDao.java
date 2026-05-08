package com.jefelabs.agentx.controlplane.catalog.persistence;

import com.jefelabs.agentx.controlplane.catalog.domain.AdapterId;
import org.jdbi.v3.sqlobject.config.RegisterConstructorMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;
import java.util.Optional;

/**
 * JDBI SqlObject DAO for {@code agents}. Same JSONB-as-String + {@code ::jsonb}
 * cast pattern as {@link FlowDao} — keeps JDBI Jackson-version-agnostic.
 * {@link AdapterId} mapping registered in
 * {@link com.jefelabs.agentx.controlplane.catalog.config.CatalogJdbiConfig}.
 */
@RegisterConstructorMapper(AgentDaoRow.class)
public interface AgentDao {

    @SqlUpdate("""
        INSERT INTO agents (org_id, id, role, adapter, system_prompt,
                            config, accepts, fallback_on, skillz,
                            created_by, updated_by)
        VALUES (:orgId, :id, :role, :adapter, :systemPrompt,
                :config::jsonb, :accepts::jsonb, :fallbackOn::jsonb, :skillz::jsonb,
                :createdBy, :createdBy)
        ON CONFLICT (org_id, id) DO UPDATE SET
            role          = EXCLUDED.role,
            adapter       = EXCLUDED.adapter,
            system_prompt = EXCLUDED.system_prompt,
            config        = EXCLUDED.config,
            accepts       = EXCLUDED.accepts,
            fallback_on   = EXCLUDED.fallback_on,
            skillz        = EXCLUDED.skillz,
            updated_at    = CURRENT_TIMESTAMP,
            updated_by    = EXCLUDED.updated_by,
            deleted_at    = NULL
    """)
    void upsert(
        @Bind("orgId") String orgId,
        @Bind("id") String id,
        @Bind("role") String role,
        @Bind("adapter") AdapterId adapter,
        @Bind("systemPrompt") String systemPrompt,
        @Bind("config") String config,
        @Bind("accepts") String accepts,
        @Bind("fallbackOn") String fallbackOn,
        @Bind("skillz") String skillz,
        @Bind("createdBy") String createdBy
    );

    @SqlQuery("""
        SELECT org_id, id, role, adapter, system_prompt,
               config::text      AS config,
               accepts::text     AS accepts,
               fallback_on::text AS fallback_on,
               skillz::text      AS skillz,
               created_at, updated_at, created_by, updated_by
          FROM agents
         WHERE org_id = :orgId AND id = :id AND deleted_at IS NULL
    """)
    Optional<AgentDaoRow> findById(@Bind("orgId") String orgId, @Bind("id") String id);

    @SqlQuery("""
        SELECT org_id, id, role, adapter, system_prompt,
               config::text      AS config,
               accepts::text     AS accepts,
               fallback_on::text AS fallback_on,
               skillz::text      AS skillz,
               created_at, updated_at, created_by, updated_by
          FROM agents
         WHERE org_id = :orgId AND deleted_at IS NULL
         ORDER BY updated_at DESC
         LIMIT :limit OFFSET :offset
    """)
    List<AgentDaoRow> listByOrg(
        @Bind("orgId") String orgId,
        @Bind("limit") int limit,
        @Bind("offset") int offset
    );

    @SqlUpdate("""
        UPDATE agents SET deleted_at = CURRENT_TIMESTAMP, updated_by = :deletedBy
         WHERE org_id = :orgId AND id = :id AND deleted_at IS NULL
    """)
    int softDelete(
        @Bind("orgId") String orgId,
        @Bind("id") String id,
        @Bind("deletedBy") String deletedBy
    );
}

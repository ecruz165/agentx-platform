package com.jefelabs.agentx.controlplane.catalog.persistence;

import com.jefelabs.agentx.controlplane.catalog.domain.SkillCategory;
import org.jdbi.v3.sqlobject.config.RegisterConstructorMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;
import java.util.Optional;

@RegisterConstructorMapper(SkillDaoRow.class)
public interface SkillDao {

    @SqlUpdate("""
        INSERT INTO skills (org_id, id, category, description, metadata, created_by, updated_by)
        VALUES (:orgId, :id, :category, :description, :metadata::jsonb, :createdBy, :createdBy)
        ON CONFLICT (org_id, id) DO UPDATE SET
            category    = EXCLUDED.category,
            description = EXCLUDED.description,
            metadata    = EXCLUDED.metadata,
            updated_at  = CURRENT_TIMESTAMP,
            updated_by  = EXCLUDED.updated_by,
            deleted_at  = NULL
    """)
    void upsert(
        @Bind("orgId") String orgId,
        @Bind("id") String id,
        @Bind("category") SkillCategory category,
        @Bind("description") String description,
        @Bind("metadata") String metadata,
        @Bind("createdBy") String createdBy
    );

    @SqlQuery("""
        SELECT org_id, id, category, description,
               metadata::text AS metadata,
               created_at, updated_at, created_by, updated_by
          FROM skills
         WHERE org_id = :orgId AND id = :id AND deleted_at IS NULL
    """)
    Optional<SkillDaoRow> findById(@Bind("orgId") String orgId, @Bind("id") String id);

    @SqlQuery("""
        SELECT org_id, id, category, description,
               metadata::text AS metadata,
               created_at, updated_at, created_by, updated_by
          FROM skills
         WHERE org_id = :orgId AND deleted_at IS NULL
         ORDER BY category, id
         LIMIT :limit OFFSET :offset
    """)
    List<SkillDaoRow> listByOrg(
        @Bind("orgId") String orgId,
        @Bind("limit") int limit,
        @Bind("offset") int offset
    );

    @SqlUpdate("""
        UPDATE skills SET deleted_at = CURRENT_TIMESTAMP, updated_by = :deletedBy
         WHERE org_id = :orgId AND id = :id AND deleted_at IS NULL
    """)
    int softDelete(
        @Bind("orgId") String orgId,
        @Bind("id") String id,
        @Bind("deletedBy") String deletedBy
    );
}

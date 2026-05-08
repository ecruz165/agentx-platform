package com.jefelabs.agentx.controlplane.catalog.persistence;

import org.jdbi.v3.sqlobject.config.RegisterConstructorMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;
import java.util.Optional;

@RegisterConstructorMapper(ProductDaoRow.class)
public interface ProductDao {

    @SqlUpdate("""
        INSERT INTO products (org_id, id, description, context_sources, repos, created_by, updated_by)
        VALUES (:orgId, :id, :description, :contextSources::jsonb, :repos::jsonb, :createdBy, :createdBy)
        ON CONFLICT (org_id, id) DO UPDATE SET
            description     = EXCLUDED.description,
            context_sources = EXCLUDED.context_sources,
            repos           = EXCLUDED.repos,
            updated_at      = CURRENT_TIMESTAMP,
            updated_by      = EXCLUDED.updated_by,
            deleted_at      = NULL
    """)
    void upsert(
        @Bind("orgId") String orgId,
        @Bind("id") String id,
        @Bind("description") String description,
        @Bind("contextSources") String contextSources,
        @Bind("repos") String repos,
        @Bind("createdBy") String createdBy
    );

    @SqlQuery("""
        SELECT org_id, id, description,
               context_sources::text AS context_sources,
               repos::text           AS repos,
               created_at, updated_at, created_by, updated_by
          FROM products
         WHERE org_id = :orgId AND id = :id AND deleted_at IS NULL
    """)
    Optional<ProductDaoRow> findById(@Bind("orgId") String orgId, @Bind("id") String id);

    @SqlQuery("""
        SELECT org_id, id, description,
               context_sources::text AS context_sources,
               repos::text           AS repos,
               created_at, updated_at, created_by, updated_by
          FROM products
         WHERE org_id = :orgId AND deleted_at IS NULL
         ORDER BY updated_at DESC
         LIMIT :limit OFFSET :offset
    """)
    List<ProductDaoRow> listByOrg(
        @Bind("orgId") String orgId,
        @Bind("limit") int limit,
        @Bind("offset") int offset
    );

    @SqlUpdate("""
        UPDATE products SET deleted_at = CURRENT_TIMESTAMP, updated_by = :deletedBy
         WHERE org_id = :orgId AND id = :id AND deleted_at IS NULL
    """)
    int softDelete(
        @Bind("orgId") String orgId,
        @Bind("id") String id,
        @Bind("deletedBy") String deletedBy
    );
}

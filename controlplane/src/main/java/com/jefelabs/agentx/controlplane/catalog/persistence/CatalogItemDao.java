package com.jefelabs.agentx.controlplane.catalog.persistence;

import com.jefelabs.agentx.controlplane.catalog.domain.CatalogItemType;
import org.jdbi.v3.sqlobject.config.RegisterConstructorMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;
import java.util.Optional;

@RegisterConstructorMapper(CatalogItemDaoRow.class)
public interface CatalogItemDao {

    @SqlUpdate("""
        INSERT INTO catalog_items
            (org_id, type, id, name, version, description, topic, tags, runtime, manifest, source)
        VALUES
            (:orgId, :type, :id, :name, :version, :description, :topic, :tags, :runtime,
             :manifest::jsonb, :source)
        ON CONFLICT (org_id, type, id) DO UPDATE SET
            name        = EXCLUDED.name,
            version     = EXCLUDED.version,
            description = EXCLUDED.description,
            topic       = EXCLUDED.topic,
            tags        = EXCLUDED.tags,
            runtime     = EXCLUDED.runtime,
            manifest    = EXCLUDED.manifest,
            source      = EXCLUDED.source,
            updated_at  = CURRENT_TIMESTAMP,
            deleted_at  = NULL
    """)
    void upsert(
        @Bind("orgId") String orgId,
        @Bind("type") CatalogItemType type,
        @Bind("id") String id,
        @Bind("name") String name,
        @Bind("version") String version,
        @Bind("description") String description,
        @Bind("topic") String topic,
        @Bind("tags") String[] tags,
        @Bind("runtime") String runtime,
        @Bind("manifest") String manifest,
        @Bind("source") String source
    );

    @SqlQuery("""
        SELECT org_id, type, id, name, version, description, topic, tags,
               runtime, manifest::text AS manifest, source, created_at, updated_at
          FROM catalog_items
         WHERE org_id = :orgId AND type = :type AND id = :id AND deleted_at IS NULL
    """)
    Optional<CatalogItemDaoRow> findById(
        @Bind("orgId") String orgId,
        @Bind("type") CatalogItemType type,
        @Bind("id") String id
    );

    @SqlQuery("""
        SELECT org_id, type, id, name, version, description, topic, tags,
               runtime, manifest::text AS manifest, source, created_at, updated_at
          FROM catalog_items
         WHERE org_id = :orgId AND deleted_at IS NULL
           AND (:type IS NULL OR type = :type)
         ORDER BY type, id
         LIMIT :limit OFFSET :offset
    """)
    List<CatalogItemDaoRow> listByOrg(
        @Bind("orgId") String orgId,
        @Bind("type") CatalogItemType type,
        @Bind("limit") int limit,
        @Bind("offset") int offset
    );

    @SqlQuery("""
        SELECT COUNT(*) FROM catalog_items
         WHERE org_id = :orgId AND deleted_at IS NULL
    """)
    long countByOrg(@Bind("orgId") String orgId);
}

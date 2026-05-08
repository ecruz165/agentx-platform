package com.jefelabs.agentx.controlplane.catalog.persistence;

import com.jefelabs.agentx.controlplane.catalog.domain.FlowKind;
import org.jdbi.v3.sqlobject.config.RegisterConstructorMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;
import java.util.Optional;

/**
 * JDBI SqlObject DAO for {@code flows}. All queries scoped by {@code org_id}
 * (multi-tenant enforcement via parameter binding — the {@code TenantContext}
 * is the source of truth at the service-layer call site).
 *
 * <p>JSONB columns ({@code output}, {@code nodes}, {@code edges}) are bound
 * as {@code String} with explicit {@code ::jsonb} SQL casts. The service
 * layer ({@link com.jefelabs.agentx.controlplane.catalog.service.FlowService})
 * converts Jackson 3 {@code JsonNode} ↔ raw JSON String at the boundary,
 * keeping the DAO independent of Jackson version (Spring Boot 4 ships
 * Jackson 3 / {@code tools.jackson}; JDBI's {@code jdbi3-jackson2} plugin
 * is on a different major version).
 *
 * <p>The {@link FlowDaoRow} record is the row-shape consumed by the
 * {@link RegisterConstructorMapper}; the service repackages it into the
 * domain {@code Flow} record after parsing JSON columns.
 */
@RegisterConstructorMapper(FlowDaoRow.class)
public interface FlowDao {

    @SqlUpdate("""
        INSERT INTO flows (org_id, id, description, kind, output, nodes, edges, created_by, updated_by)
        VALUES (:orgId, :id, :description, :kind,
                :output::jsonb, :nodes::jsonb, :edges::jsonb,
                :createdBy, :createdBy)
        ON CONFLICT (org_id, id) DO UPDATE SET
            description = EXCLUDED.description,
            kind        = EXCLUDED.kind,
            output      = EXCLUDED.output,
            nodes       = EXCLUDED.nodes,
            edges       = EXCLUDED.edges,
            updated_at  = CURRENT_TIMESTAMP,
            updated_by  = EXCLUDED.updated_by,
            deleted_at  = NULL
    """)
    void upsert(
        @Bind("orgId") String orgId,
        @Bind("id") String id,
        @Bind("description") String description,
        @Bind("kind") FlowKind kind,
        @Bind("output") String output,
        @Bind("nodes") String nodes,
        @Bind("edges") String edges,
        @Bind("createdBy") String createdBy
    );

    @SqlQuery("""
        SELECT org_id, id, description, kind,
               output::text AS output,
               nodes::text  AS nodes,
               edges::text  AS edges,
               created_at, updated_at, created_by, updated_by
          FROM flows
         WHERE org_id = :orgId AND id = :id AND deleted_at IS NULL
    """)
    Optional<FlowDaoRow> findById(@Bind("orgId") String orgId, @Bind("id") String id);

    @SqlQuery("""
        SELECT org_id, id, description, kind,
               output::text AS output,
               nodes::text  AS nodes,
               edges::text  AS edges,
               created_at, updated_at, created_by, updated_by
          FROM flows
         WHERE org_id = :orgId AND deleted_at IS NULL
         ORDER BY updated_at DESC
         LIMIT :limit OFFSET :offset
    """)
    List<FlowDaoRow> listByOrg(
        @Bind("orgId") String orgId,
        @Bind("limit") int limit,
        @Bind("offset") int offset
    );

    @SqlUpdate("""
        UPDATE flows SET deleted_at = CURRENT_TIMESTAMP, updated_by = :deletedBy
         WHERE org_id = :orgId AND id = :id AND deleted_at IS NULL
    """)
    int softDelete(
        @Bind("orgId") String orgId,
        @Bind("id") String id,
        @Bind("deletedBy") String deletedBy
    );
}

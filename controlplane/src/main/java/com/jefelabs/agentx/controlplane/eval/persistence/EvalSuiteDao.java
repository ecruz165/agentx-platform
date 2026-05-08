package com.jefelabs.agentx.controlplane.eval.persistence;

import org.jdbi.v3.sqlobject.config.RegisterConstructorMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;
import java.util.Optional;

@RegisterConstructorMapper(EvalSuiteDaoRow.class)
public interface EvalSuiteDao {

    @SqlUpdate("""
        INSERT INTO eval_suites (org_id, id, name, description, inputs, created_by)
        VALUES (:orgId, :id, :name, :description, :inputs::jsonb, :createdBy)
        ON CONFLICT (org_id, id) DO UPDATE SET
            name        = EXCLUDED.name,
            description = EXCLUDED.description,
            inputs      = EXCLUDED.inputs,
            updated_at  = CURRENT_TIMESTAMP,
            deleted_at  = NULL
    """)
    void upsert(
        @Bind("orgId") String orgId,
        @Bind("id") String id,
        @Bind("name") String name,
        @Bind("description") String description,
        @Bind("inputs") String inputs,
        @Bind("createdBy") String createdBy
    );

    @SqlQuery("""
        SELECT org_id, id, name, description,
               inputs::text AS inputs,
               created_at, updated_at, created_by
          FROM eval_suites
         WHERE org_id = :orgId AND id = :id AND deleted_at IS NULL
    """)
    Optional<EvalSuiteDaoRow> findById(@Bind("orgId") String orgId, @Bind("id") String id);

    @SqlQuery("""
        SELECT org_id, id, name, description,
               inputs::text AS inputs,
               created_at, updated_at, created_by
          FROM eval_suites
         WHERE org_id = :orgId AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT :limit OFFSET :offset
    """)
    List<EvalSuiteDaoRow> listByOrg(
        @Bind("orgId") String orgId,
        @Bind("limit") int limit,
        @Bind("offset") int offset
    );

    @SqlUpdate("""
        UPDATE eval_suites SET deleted_at = CURRENT_TIMESTAMP
         WHERE org_id = :orgId AND id = :id AND deleted_at IS NULL
    """)
    int softDelete(@Bind("orgId") String orgId, @Bind("id") String id);
}

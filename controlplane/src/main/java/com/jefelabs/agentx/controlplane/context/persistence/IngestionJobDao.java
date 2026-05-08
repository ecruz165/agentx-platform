package com.jefelabs.agentx.controlplane.context.persistence;

import org.jdbi.v3.sqlobject.config.RegisterConstructorMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.statement.SqlQuery;

import java.util.List;

@RegisterConstructorMapper(IngestionJobDaoRow.class)
public interface IngestionJobDao {

    @SqlQuery("""
        SELECT id, org_id, source_id, status, chunk_count, failure_reason,
               created_at, started_at, completed_at
          FROM ingestion_jobs
         WHERE org_id = :orgId AND source_id = :sourceId
         ORDER BY created_at DESC
         LIMIT :limit
    """)
    List<IngestionJobDaoRow> listBySource(
        @Bind("orgId") String orgId,
        @Bind("sourceId") String sourceId,
        @Bind("limit") int limit
    );
}

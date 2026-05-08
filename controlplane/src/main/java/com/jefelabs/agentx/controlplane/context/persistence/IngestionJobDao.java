package com.jefelabs.agentx.controlplane.context.persistence;

import com.jefelabs.agentx.controlplane.context.domain.IngestionStatus;
import org.jdbi.v3.sqlobject.config.RegisterConstructorMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.statement.GetGeneratedKeys;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@RegisterConstructorMapper(IngestionJobDaoRow.class)
public interface IngestionJobDao {

    @SqlUpdate("""
        INSERT INTO ingestion_jobs (org_id, source_id, status)
        VALUES (:orgId, :sourceId, :status)
    """)
    @GetGeneratedKeys("id")
    UUID create(
        @Bind("orgId") String orgId,
        @Bind("sourceId") String sourceId,
        @Bind("status") IngestionStatus status
    );

    @SqlUpdate("""
        UPDATE ingestion_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP
         WHERE id = :id
    """)
    int markRunning(@Bind("id") UUID id);

    @SqlUpdate("""
        UPDATE ingestion_jobs SET status = 'completed', chunk_count = :chunkCount,
                                  completed_at = CURRENT_TIMESTAMP
         WHERE id = :id
    """)
    int markCompleted(@Bind("id") UUID id, @Bind("chunkCount") int chunkCount);

    @SqlUpdate("""
        UPDATE ingestion_jobs SET status = 'failed', failure_reason = :reason,
                                  completed_at = CURRENT_TIMESTAMP
         WHERE id = :id
    """)
    int markFailed(@Bind("id") UUID id, @Bind("reason") String reason);

    @SqlQuery("""
        SELECT id, org_id, source_id, status, chunk_count, failure_reason,
               created_at, started_at, completed_at
          FROM ingestion_jobs
         WHERE id = :id
    """)
    Optional<IngestionJobDaoRow> findById(@Bind("id") UUID id);

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

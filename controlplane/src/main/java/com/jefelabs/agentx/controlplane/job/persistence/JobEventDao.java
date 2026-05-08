package com.jefelabs.agentx.controlplane.job.persistence;

import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

/**
 * Job event audit log. Append-only; queries (paginated history + SSE
 * stream) land with the event-stream surface in Phase 3.x.
 */
public interface JobEventDao {

    @SqlUpdate("""
        INSERT INTO job_events (org_id, job_id, event_type, node_id, payload)
        VALUES (:orgId, :jobId, :eventType, :nodeId, :payload::jsonb)
    """)
    void emit(
        @Bind("orgId") String orgId,
        @Bind("jobId") String jobId,
        @Bind("eventType") String eventType,
        @Bind("nodeId") String nodeId,
        @Bind("payload") String payload
    );
}

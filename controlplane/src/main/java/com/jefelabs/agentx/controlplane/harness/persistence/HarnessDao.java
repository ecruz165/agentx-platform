package com.jefelabs.agentx.controlplane.harness.persistence;

import com.jefelabs.agentx.controlplane.harness.domain.HarnessStatus;
import org.jdbi.v3.sqlobject.config.RegisterConstructorMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;
import java.util.Optional;

@RegisterConstructorMapper(HarnessDaoRow.class)
public interface HarnessDao {

    @SqlUpdate("""
        INSERT INTO harnesses (org_id, id, name, version, status, region,
                               capabilities, endpoints, session_token,
                               registered_at, updated_at)
        VALUES (:orgId, :id, :name, :version, :status, :region,
                :capabilities::jsonb, :endpoints::jsonb, :sessionToken,
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (org_id, id) DO UPDATE SET
            name          = EXCLUDED.name,
            version       = EXCLUDED.version,
            status        = EXCLUDED.status,
            region        = EXCLUDED.region,
            capabilities  = EXCLUDED.capabilities,
            endpoints     = EXCLUDED.endpoints,
            session_token = EXCLUDED.session_token,
            updated_at    = CURRENT_TIMESTAMP
    """)
    void registerOrUpdate(
        @Bind("orgId") String orgId,
        @Bind("id") String id,
        @Bind("name") String name,
        @Bind("version") String version,
        @Bind("status") HarnessStatus status,
        @Bind("region") String region,
        @Bind("capabilities") String capabilities,
        @Bind("endpoints") String endpoints,
        @Bind("sessionToken") String sessionToken
    );

    @SqlUpdate("""
        UPDATE harnesses SET
            status            = 'active',
            current_load      = :currentLoad,
            last_heartbeat_at = CURRENT_TIMESTAMP,
            updated_at        = CURRENT_TIMESTAMP
         WHERE org_id = :orgId AND id = :id
           AND session_token IS NOT DISTINCT FROM :sessionToken
    """)
    int recordHeartbeat(
        @Bind("orgId") String orgId,
        @Bind("id") String id,
        @Bind("sessionToken") String sessionToken,
        @Bind("currentLoad") Integer currentLoad
    );

    @SqlUpdate("""
        UPDATE harnesses SET status = 'disconnected', updated_at = CURRENT_TIMESTAMP
         WHERE org_id = :orgId AND id = :id
    """)
    int markDisconnected(@Bind("orgId") String orgId, @Bind("id") String id);

    @SqlQuery("""
        SELECT org_id, id, name, version, status, region,
               capabilities::text AS capabilities,
               endpoints::text    AS endpoints,
               current_load, session_token,
               last_heartbeat_at, registered_at, updated_at
          FROM harnesses
         WHERE org_id = :orgId AND id = :id
    """)
    Optional<HarnessDaoRow> findById(@Bind("orgId") String orgId, @Bind("id") String id);

    @SqlQuery("""
        SELECT org_id, id, name, version, status, region,
               capabilities::text AS capabilities,
               endpoints::text    AS endpoints,
               current_load, session_token,
               last_heartbeat_at, registered_at, updated_at
          FROM harnesses
         WHERE org_id = :orgId
           AND status <> 'disconnected'
         ORDER BY last_heartbeat_at DESC NULLS LAST
         LIMIT :limit OFFSET :offset
    """)
    List<HarnessDaoRow> listActiveByOrg(
        @Bind("orgId") String orgId,
        @Bind("limit") int limit,
        @Bind("offset") int offset
    );
}

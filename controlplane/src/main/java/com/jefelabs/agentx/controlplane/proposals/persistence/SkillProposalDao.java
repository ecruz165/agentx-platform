package com.jefelabs.agentx.controlplane.proposals.persistence;

import com.jefelabs.agentx.controlplane.proposals.domain.ProposalStatus;
import org.jdbi.v3.sqlobject.config.RegisterConstructorMapper;
import org.jdbi.v3.sqlobject.customizer.Bind;
import org.jdbi.v3.sqlobject.statement.GetGeneratedKeys;
import org.jdbi.v3.sqlobject.statement.SqlQuery;
import org.jdbi.v3.sqlobject.statement.SqlUpdate;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@RegisterConstructorMapper(SkillProposalDaoRow.class)
public interface SkillProposalDao {

    @SqlUpdate("""
        INSERT INTO skill_proposals
            (org_id, source_job_id, name, description, rationale, category, tags, status)
        VALUES
            (:orgId, :sourceJobId, :name, :description, :rationale, :category, :tags, 'proposed')
    """)
    @GetGeneratedKeys("id")
    UUID create(
        @Bind("orgId") String orgId,
        @Bind("sourceJobId") String sourceJobId,
        @Bind("name") String name,
        @Bind("description") String description,
        @Bind("rationale") String rationale,
        @Bind("category") String category,
        @Bind("tags") String[] tags
    );

    @SqlQuery("""
        SELECT id, org_id, source_job_id, name, description, rationale,
               category, tags, status, reviewer, reviewed_at,
               rejection_reason, catalog_item_id, created_at,
               remote_id, remote_status, remote_url, remote_error,
               remote_synced_at
          FROM skill_proposals
         WHERE org_id = :orgId AND id = :id
    """)
    Optional<SkillProposalDaoRow> findById(@Bind("orgId") String orgId, @Bind("id") UUID id);

    @SqlQuery("""
        SELECT id, org_id, source_job_id, name, description, rationale,
               category, tags, status, reviewer, reviewed_at,
               rejection_reason, catalog_item_id, created_at,
               remote_id, remote_status, remote_url, remote_error,
               remote_synced_at
          FROM skill_proposals
         WHERE org_id = :orgId
           AND (:status IS NULL OR status = :status)
         ORDER BY created_at DESC
         LIMIT :limit OFFSET :offset
    """)
    List<SkillProposalDaoRow> listByOrg(
        @Bind("orgId") String orgId,
        @Bind("status") ProposalStatus status,
        @Bind("limit") int limit,
        @Bind("offset") int offset
    );

    @SqlUpdate("""
        UPDATE skill_proposals SET
            status          = 'approved',
            reviewer        = :reviewer,
            reviewed_at     = CURRENT_TIMESTAMP,
            catalog_item_id = :catalogItemId
         WHERE org_id = :orgId AND id = :id AND status = 'proposed'
    """)
    int approve(
        @Bind("orgId") String orgId,
        @Bind("id") UUID id,
        @Bind("reviewer") String reviewer,
        @Bind("catalogItemId") String catalogItemId
    );

    @SqlUpdate("""
        UPDATE skill_proposals SET
            status           = 'rejected',
            reviewer         = :reviewer,
            reviewed_at      = CURRENT_TIMESTAMP,
            rejection_reason = :reason
         WHERE org_id = :orgId AND id = :id AND status = 'proposed'
    """)
    int reject(
        @Bind("orgId") String orgId,
        @Bind("id") UUID id,
        @Bind("reviewer") String reviewer,
        @Bind("reason") String reason
    );

    /**
     * Record the result of POSTing the proposal to skillzkit. Both the
     * success path and the transport-failure path land here — successes
     * write {@code remote_id + remote_status + remote_url}; failures
     * write {@code remote_status='failed' + remote_error}. Either way
     * {@code remote_synced_at} is bumped so operators can see when the
     * last attempt happened.
     */
    @SqlUpdate("""
        UPDATE skill_proposals SET
            remote_id        = :remoteId,
            remote_status    = :remoteStatus,
            remote_url       = :remoteUrl,
            remote_error     = :remoteError,
            remote_synced_at = CURRENT_TIMESTAMP
         WHERE org_id = :orgId AND id = :id
    """)
    int recordRemoteSubmission(
        @Bind("orgId") String orgId,
        @Bind("id") UUID id,
        @Bind("remoteId") String remoteId,
        @Bind("remoteStatus") String remoteStatus,
        @Bind("remoteUrl") String remoteUrl,
        @Bind("remoteError") String remoteError
    );

    /**
     * Walk proposals whose remote submission is in flight (status
     * {@code 'pending'} or {@code 'reviewing'}). The status-poller
     * iterates this list and re-fetches each from skillzkit. Sorted
     * by the partial-index key so cron iterations deal with the
     * stalest first.
     */
    @SqlQuery("""
        SELECT id, org_id, source_job_id, name, description, rationale,
               category, tags, status, reviewer, reviewed_at,
               rejection_reason, catalog_item_id, created_at,
               remote_id, remote_status, remote_url, remote_error,
               remote_synced_at
          FROM skill_proposals
         WHERE remote_status IN ('pending', 'reviewing')
           AND remote_id IS NOT NULL
         ORDER BY remote_synced_at ASC NULLS FIRST
         LIMIT :limit
    """)
    List<SkillProposalDaoRow> listRemoteInFlight(@Bind("limit") int limit);

    /**
     * Update remote_status from a poll cycle. Distinct from
     * {@link #recordRemoteSubmission} because polling only knows the
     * current status — it doesn't carry id/url/error fields, so this
     * leaves them alone. Always bumps remote_synced_at so operators
     * see the last-poll time even when status hasn't moved.
     */
    @SqlUpdate("""
        UPDATE skill_proposals SET
            remote_status    = :remoteStatus,
            remote_synced_at = CURRENT_TIMESTAMP,
            remote_error     = NULL
         WHERE org_id = :orgId AND id = :id
    """)
    int updateRemoteStatusFromPoll(
        @Bind("orgId") String orgId,
        @Bind("id") UUID id,
        @Bind("remoteStatus") String remoteStatus
    );

    /**
     * Clear the local catalog_items pointer on a proposal. Called when
     * the upstream draft has been retired (e.g., skillzkit accepted
     * the proposal and the canonical version will arrive via the next
     * agentx-load sync). Doesn't change the proposal's own
     * {@code status} — that's a separate state machine.
     */
    @SqlUpdate("""
        UPDATE skill_proposals SET
            catalog_item_id = NULL
         WHERE org_id = :orgId AND id = :id
    """)
    int clearLocalDraftReference(
        @Bind("orgId") String orgId,
        @Bind("id") UUID id
    );
}

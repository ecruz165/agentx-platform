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
               rejection_reason, catalog_item_id, created_at
          FROM skill_proposals
         WHERE org_id = :orgId AND id = :id
    """)
    Optional<SkillProposalDaoRow> findById(@Bind("orgId") String orgId, @Bind("id") UUID id);

    @SqlQuery("""
        SELECT id, org_id, source_job_id, name, description, rationale,
               category, tags, status, reviewer, reviewed_at,
               rejection_reason, catalog_item_id, created_at
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
}

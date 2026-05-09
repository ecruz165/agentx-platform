package com.jefelabs.agentx.controlplane.proposals.persistence;

import com.jefelabs.agentx.controlplane.proposals.domain.ProposalStatus;

import java.time.Instant;
import java.util.UUID;

public record SkillProposalDaoRow(
    UUID id,
    String orgId,
    String sourceJobId,
    String name,
    String description,
    String rationale,
    String category,
    String[] tags,
    ProposalStatus status,
    String reviewer,
    Instant reviewedAt,
    String rejectionReason,
    String catalogItemId,
    Instant createdAt,
    /** Skillzkit upstream tracking — see SkillProposal javadoc. */
    String remoteId,
    String remoteStatus,
    String remoteUrl,
    String remoteError,
    Instant remoteSyncedAt
) {
}

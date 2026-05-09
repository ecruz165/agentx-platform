package com.jefelabs.agentx.controlplane.proposals.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.jefelabs.agentx.controlplane.proposals.domain.ProposalStatus;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record SkillProposalDTO(
    UUID id,
    String sourceJobId,
    String name,
    String description,
    String rationale,
    String category,
    List<String> tags,
    ProposalStatus status,
    String reviewer,
    Instant reviewedAt,
    String rejectionReason,
    String catalogItemId,
    Instant createdAt,
    /** Skillzkit upstream submission state — null if never submitted
     *  (e.g., approved before skillzkit was wired). See
     *  {@link com.jefelabs.agentx.controlplane.proposals.domain.SkillProposal}. */
    String remoteId,
    String remoteStatus,
    String remoteUrl,
    String remoteError,
    Instant remoteSyncedAt
) {
}

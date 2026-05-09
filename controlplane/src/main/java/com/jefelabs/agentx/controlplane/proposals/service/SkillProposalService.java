package com.jefelabs.agentx.controlplane.proposals.service;

import com.jefelabs.agentx.controlplane.catalog.domain.CatalogItem;
import com.jefelabs.agentx.controlplane.catalog.domain.CatalogItemType;
import com.jefelabs.agentx.controlplane.catalog.service.CatalogItemService;
import com.jefelabs.agentx.controlplane.proposals.domain.ProposalStatus;
import com.jefelabs.agentx.controlplane.proposals.domain.SkillProposal;
import com.jefelabs.agentx.controlplane.proposals.integration.SkillzkitClient;
import com.jefelabs.agentx.controlplane.proposals.persistence.SkillProposalDao;
import com.jefelabs.agentx.controlplane.proposals.persistence.SkillProposalDaoRow;
import org.jdbi.v3.core.Jdbi;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Skill-proposal lifecycle: create from a job's reflection, list for
 * admin review, approve (seeds a draft into catalog_items), reject.
 */
@Service
public class SkillProposalService {

    private final Jdbi jdbi;
    private final ObjectMapper objectMapper;
    private final CatalogItemService catalogItemService;
    private final SkillzkitClient skillzkitClient;

    public SkillProposalService(
        Jdbi jdbi,
        ObjectMapper objectMapper,
        CatalogItemService catalogItemService,
        SkillzkitClient skillzkitClient
    ) {
        this.jdbi = jdbi;
        this.objectMapper = objectMapper;
        this.catalogItemService = catalogItemService;
        this.skillzkitClient = skillzkitClient;
    }

    @Transactional
    public SkillProposal create(
        String orgId, String sourceJobId,
        String name, String description, String rationale,
        String category, List<String> tags
    ) {
        SkillProposalDao dao = jdbi.onDemand(SkillProposalDao.class);
        String[] tagsArr = tags != null ? tags.toArray(String[]::new) : new String[0];
        UUID id = dao.create(orgId, sourceJobId, name, description, rationale, category, tagsArr);
        return dao.findById(orgId, id)
            .map(this::toDomain)
            .orElseThrow(() -> new IllegalStateException("Proposal insert succeeded but row missing: " + id));
    }

    /**
     * Walk a reflection's surprises array and create proposals for
     * every entry where {@code kind == 'missing-skill'}. Returns the
     * created proposals.
     */
    @Transactional
    public List<SkillProposal> createFromSurprises(
        String orgId, String sourceJobId, JsonNode surprises
    ) {
        if (surprises == null || !surprises.isArray()) return List.of();
        List<SkillProposal> out = new java.util.ArrayList<>();
        for (JsonNode s : surprises) {
            if (!s.isObject()) continue;
            String kind = s.path("kind").asText("");
            if (!"missing-skill".equals(kind)) continue;
            String name = s.path("name").asText(null);
            if (name == null || name.isBlank()) continue;
            List<String> tags = new java.util.ArrayList<>();
            JsonNode tagsNode = s.path("tags");
            if (tagsNode != null && tagsNode.isArray()) {
                for (JsonNode t : tagsNode) {
                    if (t.isTextual()) tags.add(t.asText());
                }
            }
            out.add(create(
                orgId, sourceJobId,
                name,
                s.path("description").asText(null),
                s.path("why").asText(s.path("rationale").asText(null)),
                s.path("category").asText(null),
                tags
            ));
        }
        return out;
    }

    public Optional<SkillProposal> findById(String orgId, UUID id) {
        return jdbi.onDemand(SkillProposalDao.class).findById(orgId, id).map(this::toDomain);
    }

    public List<SkillProposal> listByOrg(
        String orgId, ProposalStatus status, int limit, int offset
    ) {
        return jdbi.onDemand(SkillProposalDao.class)
            .listByOrg(orgId, status, limit, offset).stream()
            .map(this::toDomain)
            .toList();
    }

    /**
     * Approve a proposal. Seeds a draft {@code catalog_items} row
     * (type=skill, source='skillzkit') from the proposal fields so
     * users can immediately reference the skill from a flow; a future
     * iteration syncs the draft back to the @ecruz165/skillzkit repo
     * as a real PR.
     */
    @Transactional
    public Optional<SkillProposal> approve(String orgId, UUID id, String reviewer) {
        SkillProposalDao dao = jdbi.onDemand(SkillProposalDao.class);
        SkillProposal proposal = dao.findById(orgId, id).map(this::toDomain).orElse(null);
        if (proposal == null) return Optional.empty();
        if (proposal.status() != ProposalStatus.PROPOSED) {
            throw new IllegalStateException(
                "Proposal " + id + " is " + proposal.status() + "; only proposed → approved is valid");
        }

        // Seed a draft catalog_items row.
        var manifest = objectMapper.createObjectNode();
        manifest.put("name", proposal.name());
        manifest.put("type", "skill");
        if (proposal.description() != null) manifest.put("description", proposal.description());
        if (proposal.rationale() != null) manifest.put("rationale", proposal.rationale());
        manifest.put("source", "proposal");
        manifest.put("proposal_id", proposal.id().toString());
        if (proposal.sourceJobId() != null) manifest.put("source_job_id", proposal.sourceJobId());
        var tagsNode = manifest.putArray("tags");
        for (String t : proposal.tags()) tagsNode.add(t);

        CatalogItem seeded = catalogItemService.upsert(new CatalogItem(
            orgId,
            CatalogItemType.SKILL,
            proposal.name(),
            proposal.name(),
            null,                       // version
            proposal.description(),
            proposal.category(),        // topic
            proposal.tags(),
            null,                       // runtime
            manifest,
            "skillzkit",                // source — keeps the existing CHECK happy
            null, null
        ));

        int updated = dao.approve(orgId, id, reviewer, seeded.id());
        if (updated == 0) {
            throw new IllegalStateException(
                "Proposal " + id + " could not be marked approved");
        }

        // Round-trip back to skillzkit (the source-of-truth catalog).
        // Errors are recorded on the row but DON'T fail the approve —
        // the local catalog cache works regardless, and operators can
        // resubmit later via /api/skill-proposals/{id}/resubmit.
        SkillProposal approvedProposal = dao.findById(orgId, id)
            .map(this::toDomain)
            .orElseThrow(() -> new IllegalStateException("approved proposal vanished: " + id));
        SkillzkitClient.SubmitResult result = skillzkitClient.submit(approvedProposal);
        switch (result) {
            case SkillzkitClient.SubmitResult.Submitted s ->
                dao.recordRemoteSubmission(orgId, id, s.remoteId(), s.remoteStatus(), s.remoteUrl(), null);
            case SkillzkitClient.SubmitResult.Failed f ->
                dao.recordRemoteSubmission(orgId, id, null, "failed", null, f.error());
            case SkillzkitClient.SubmitResult.Skipped __ ->
                // Skillzkit not configured — leave remote_* null so the
                // poller / resubmit endpoint can pick it up later.
                {}
        }

        return dao.findById(orgId, id).map(this::toDomain);
    }

    /**
     * Refresh a proposal's remote_status from skillzkit. Called by the
     * periodic poller. On a successful fetch, writes the current
     * status; if status is terminal-accepted ({@code accepted} or
     * {@code promoted}), also drops the local catalog_items draft and
     * clears the proposal's {@code catalog_item_id} pointer — the
     * next agentx-load sync will resurrect the canonical entry from
     * skillzkit.
     *
     * <p>{@code rejected} updates remote_status but keeps the local
     * draft (the user may still want the skill locally even if
     * skillzkit reviewers don't ship it).
     *
     * <p>Fetch failures (network, 5xx, etc.) leave the row alone so
     * remote_synced_at staying old is the operator's signal that
     * polling isn't progressing. Caller logs the underlying error.
     *
     * @return true iff a status update was written.
     */
    @Transactional
    public boolean refreshRemoteStatus(String orgId, UUID id, String remoteId) {
        if (remoteId == null || remoteId.isBlank()) return false;
        SkillProposalDao dao = jdbi.onDemand(SkillProposalDao.class);
        SkillzkitClient.FetchResult result = skillzkitClient.fetch(remoteId);
        if (!(result instanceof SkillzkitClient.FetchResult.Fetched fetched)) {
            return false;
        }
        dao.updateRemoteStatusFromPoll(orgId, id, fetched.remoteStatus());
        if ("accepted".equals(fetched.remoteStatus()) || "promoted".equals(fetched.remoteStatus())) {
            SkillProposal proposal = dao.findById(orgId, id).map(this::toDomain).orElse(null);
            if (proposal != null && proposal.catalogItemId() != null) {
                catalogItemService.softDelete(
                    orgId,
                    com.jefelabs.agentx.controlplane.catalog.domain.CatalogItemType.SKILL,
                    proposal.catalogItemId()
                );
                dao.clearLocalDraftReference(orgId, id);
            }
        }
        return true;
    }

    /**
     * Resubmit a proposal to skillzkit. Used to retry after a
     * {@code remote_status='failed'} OR to push proposals approved
     * before skillzkit was configured. Only valid for proposals
     * already in {@code approved} state.
     */
    @Transactional
    public Optional<SkillProposal> resubmitToSkillzkit(String orgId, UUID id) {
        SkillProposalDao dao = jdbi.onDemand(SkillProposalDao.class);
        SkillProposal proposal = dao.findById(orgId, id).map(this::toDomain).orElse(null);
        if (proposal == null) return Optional.empty();
        if (proposal.status() != ProposalStatus.APPROVED) {
            throw new IllegalStateException(
                "Proposal " + id + " is " + proposal.status() + "; only approved proposals can be resubmitted");
        }
        SkillzkitClient.SubmitResult result = skillzkitClient.submit(proposal);
        switch (result) {
            case SkillzkitClient.SubmitResult.Submitted s ->
                dao.recordRemoteSubmission(orgId, id, s.remoteId(), s.remoteStatus(), s.remoteUrl(), null);
            case SkillzkitClient.SubmitResult.Failed f ->
                dao.recordRemoteSubmission(orgId, id, null, "failed", null, f.error());
            case SkillzkitClient.SubmitResult.Skipped __ ->
                dao.recordRemoteSubmission(orgId, id, null, "failed", null,
                    "skillzkit is not configured (agentx.skillzkit.url is empty)");
        }
        return dao.findById(orgId, id).map(this::toDomain);
    }

    @Transactional
    public Optional<SkillProposal> reject(String orgId, UUID id, String reviewer, String reason) {
        SkillProposalDao dao = jdbi.onDemand(SkillProposalDao.class);
        int updated = dao.reject(orgId, id, reviewer, reason);
        return updated > 0 ? dao.findById(orgId, id).map(this::toDomain) : Optional.empty();
    }

    // ── helpers ───────────────────────────────────────────────────────────

    private SkillProposal toDomain(SkillProposalDaoRow row) {
        return new SkillProposal(
            row.id(), row.orgId(), row.sourceJobId(),
            row.name(), row.description(), row.rationale(), row.category(),
            row.tags() != null ? List.of(row.tags()) : List.of(),
            row.status(), row.reviewer(), row.reviewedAt(),
            row.rejectionReason(), row.catalogItemId(),
            row.createdAt(),
            row.remoteId(), row.remoteStatus(), row.remoteUrl(),
            row.remoteError(), row.remoteSyncedAt()
        );
    }
}

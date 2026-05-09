package com.jefelabs.agentx.controlplane.proposals.api;

import com.jefelabs.agentx.controlplane.core.tenancy.TenantContext;
import com.jefelabs.agentx.controlplane.proposals.api.dto.ApiErrorEnvelopeDTO;
import com.jefelabs.agentx.controlplane.proposals.api.dto.ComposeRequestDTO;
import com.jefelabs.agentx.controlplane.proposals.api.dto.RejectProposalRequestDTO;
import com.jefelabs.agentx.controlplane.proposals.api.dto.SkillProposalDTO;
import com.jefelabs.agentx.controlplane.proposals.domain.ProposalStatus;
import com.jefelabs.agentx.controlplane.proposals.domain.SkillProposal;
import com.jefelabs.agentx.controlplane.proposals.integration.SkillzkitClient;
import com.jefelabs.agentx.controlplane.proposals.service.SkillProposalService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/skill-proposals")
public class SkillProposalController {

    private final SkillProposalService service;
    private final SkillzkitClient skillzkitClient;

    public SkillProposalController(
        SkillProposalService service,
        SkillzkitClient skillzkitClient
    ) {
        this.service = service;
        this.skillzkitClient = skillzkitClient;
    }

    @GetMapping
    public List<SkillProposalDTO> list(
        @RequestParam(required = false) ProposalStatus status,
        @RequestParam(defaultValue = "100") int limit,
        @RequestParam(defaultValue = "0") int offset
    ) {
        var tenant = TenantContext.current();
        return service.listByOrg(tenant.orgId(), status, limit, offset).stream()
            .map(SkillProposalController::toDTO)
            .toList();
    }

    @GetMapping("/{id}")
    public ResponseEntity<SkillProposalDTO> getById(@PathVariable UUID id) {
        var tenant = TenantContext.current();
        return service.findById(tenant.orgId(), id)
            .map(SkillProposalController::toDTO)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping("/{id}/approve")
    public ResponseEntity<SkillProposalDTO> approve(@PathVariable UUID id) {
        var tenant = TenantContext.current();
        return service.approve(tenant.orgId(), id, tenant.userId())
            .map(SkillProposalController::toDTO)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping("/{id}/reject")
    public ResponseEntity<SkillProposalDTO> reject(
        @PathVariable UUID id,
        @RequestBody RejectProposalRequestDTO body
    ) {
        var tenant = TenantContext.current();
        return service.reject(tenant.orgId(), id, tenant.userId(), body.reason())
            .map(SkillProposalController::toDTO)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /**
     * Retry a previously-approved proposal's submission to skillzkit.
     * Used after a transport failure (remote_status='failed') OR for
     * proposals approved before skillzkit was configured (remote_status
     * is null). Returns 404 if the proposal isn't approved yet.
     */
    @PostMapping("/{id}/resubmit")
    public ResponseEntity<SkillProposalDTO> resubmit(@PathVariable UUID id) {
        var tenant = TenantContext.current();
        return service.resubmitToSkillzkit(tenant.orgId(), id)
            .map(SkillProposalController::toDTO)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /**
     * Compose-from-scratch contribution endpoint. Bypasses the
     * proposal flow: forwards the caller's bundle directly to
     * skillzkit's {@code POST /api/v1/contributions} via
     * {@link SkillzkitClient#submitContribution} and returns the
     * structured result.
     *
     * <p>Status mapping:
     * <ul>
     *   <li>2xx from skillzkit → 200 OK with {@code ComposeResponseDTO}
     *   <li>4xx from skillzkit → same status with
     *       {@link ApiErrorEnvelopeDTO} (preserves
     *       {@code validation_failed} findings,
     *       {@code author_mismatch} owner id, {@code slug_conflict}
     *       version, etc.)
     *   <li>skillzkit unreachable → 502 Bad Gateway
     *   <li>skillzkit not configured → 503 Service Unavailable
     * </ul>
     *
     * <p>Authentication: this endpoint trusts the
     * {@link TenantContext}-resolved user; the actual skillzkit token
     * is server-side ({@code agentx.skillzkit.token}). The compose
     * caller never sees the upstream credential.
     */
    @PostMapping("/compose")
    public ResponseEntity<?> compose(@RequestBody ComposeRequestDTO body) {
        if (body == null
            || body.kind() == null || body.kind().isBlank()
            || body.slug() == null || body.slug().isBlank()
            || body.files() == null || body.files().isEmpty()
        ) {
            return ResponseEntity
                .badRequest()
                .body(new ApiErrorEnvelopeDTO(
                    "validation_failed",
                    "Request must include kind, slug, and at least one file",
                    null
                ));
        }
        SkillzkitClient.ComposeResult result = skillzkitClient.submitContribution(body);
        if (result instanceof SkillzkitClient.ComposeResult.Submitted s) {
            return ResponseEntity.ok(s.response());
        }
        if (result instanceof SkillzkitClient.ComposeResult.ApiError e) {
            return ResponseEntity
                .status(e.httpStatus())
                .body(new ApiErrorEnvelopeDTO(e.code(), e.message(), e.details()));
        }
        if (result instanceof SkillzkitClient.ComposeResult.TransportError t) {
            return ResponseEntity
                .status(HttpStatus.BAD_GATEWAY)
                .body(new ApiErrorEnvelopeDTO(
                    "skillzkit_unreachable",
                    "Could not reach skillzkit: " + t.message(),
                    null
                ));
        }
        // Skipped — not configured
        return ResponseEntity
            .status(HttpStatus.SERVICE_UNAVAILABLE)
            .body(new ApiErrorEnvelopeDTO(
                "skillzkit_unavailable",
                "skillzkit is not configured on this controlplane",
                Map.of("setting", "agentx.skillzkit.url")
            ));
    }

    private static SkillProposalDTO toDTO(SkillProposal p) {
        return new SkillProposalDTO(
            p.id(), p.sourceJobId(), p.name(), p.description(), p.rationale(),
            p.category(), p.tags(), p.status(), p.reviewer(), p.reviewedAt(),
            p.rejectionReason(), p.catalogItemId(), p.createdAt(),
            p.remoteId(), p.remoteStatus(), p.remoteUrl(),
            p.remoteError(), p.remoteSyncedAt()
        );
    }
}

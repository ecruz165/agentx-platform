package com.jefelabs.agentx.controlplane.proposals.api;

import com.jefelabs.agentx.controlplane.core.tenancy.TenantContext;
import com.jefelabs.agentx.controlplane.proposals.api.dto.RejectProposalRequestDTO;
import com.jefelabs.agentx.controlplane.proposals.api.dto.SkillProposalDTO;
import com.jefelabs.agentx.controlplane.proposals.domain.ProposalStatus;
import com.jefelabs.agentx.controlplane.proposals.domain.SkillProposal;
import com.jefelabs.agentx.controlplane.proposals.service.SkillProposalService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/skill-proposals")
public class SkillProposalController {

    private final SkillProposalService service;

    public SkillProposalController(SkillProposalService service) {
        this.service = service;
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

    private static SkillProposalDTO toDTO(SkillProposal p) {
        return new SkillProposalDTO(
            p.id(), p.sourceJobId(), p.name(), p.description(), p.rationale(),
            p.category(), p.tags(), p.status(), p.reviewer(), p.reviewedAt(),
            p.rejectionReason(), p.catalogItemId(), p.createdAt()
        );
    }
}

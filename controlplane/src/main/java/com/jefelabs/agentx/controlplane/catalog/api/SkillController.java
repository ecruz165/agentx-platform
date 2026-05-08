package com.jefelabs.agentx.controlplane.catalog.api;

import com.jefelabs.agentx.controlplane.catalog.api.dto.SkillCreateRequestDTO;
import com.jefelabs.agentx.controlplane.catalog.api.dto.SkillDTO;
import com.jefelabs.agentx.controlplane.catalog.api.mapper.SkillMapper;
import com.jefelabs.agentx.controlplane.catalog.service.SkillService;
import com.jefelabs.agentx.controlplane.core.tenancy.TenantContext;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/catalog/skills")
public class SkillController {

    private final SkillService skillService;
    private final SkillMapper skillMapper;

    public SkillController(SkillService skillService, SkillMapper skillMapper) {
        this.skillService = skillService;
        this.skillMapper = skillMapper;
    }

    @PostMapping
    public ResponseEntity<SkillDTO> upsert(@RequestBody SkillCreateRequestDTO body) {
        var tenant = TenantContext.current();
        var domain = skillMapper.toDomain(body, tenant.orgId());
        var saved = skillService.upsert(domain);
        return ResponseEntity.status(HttpStatus.CREATED).body(skillMapper.toDTO(saved));
    }

    @GetMapping("/{id}")
    public ResponseEntity<SkillDTO> getById(@PathVariable String id) {
        var tenant = TenantContext.current();
        return skillService.findById(tenant.orgId(), id)
            .map(skillMapper::toDTO)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping
    public List<SkillDTO> list(
        @RequestParam(defaultValue = "100") int limit,
        @RequestParam(defaultValue = "0") int offset
    ) {
        var tenant = TenantContext.current();
        return skillService.listByOrg(tenant.orgId(), limit, offset).stream()
            .map(skillMapper::toDTO)
            .toList();
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        var tenant = TenantContext.current();
        boolean removed = skillService.softDelete(tenant.orgId(), id, tenant.userId());
        return removed ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }
}

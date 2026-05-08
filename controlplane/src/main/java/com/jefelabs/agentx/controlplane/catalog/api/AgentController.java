package com.jefelabs.agentx.controlplane.catalog.api;

import com.jefelabs.agentx.controlplane.catalog.api.dto.AgentCreateRequestDTO;
import com.jefelabs.agentx.controlplane.catalog.api.dto.AgentDTO;
import com.jefelabs.agentx.controlplane.catalog.api.mapper.AgentMapper;
import com.jefelabs.agentx.controlplane.catalog.service.AgentService;
import com.jefelabs.agentx.controlplane.core.tenancy.TenantContext;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Thin HTTP edge for catalog agents. Same layering as {@link FlowController}.
 */
@RestController
@RequestMapping("/api/catalog/agents")
public class AgentController {

    private final AgentService agentService;
    private final AgentMapper agentMapper;

    public AgentController(AgentService agentService, AgentMapper agentMapper) {
        this.agentService = agentService;
        this.agentMapper = agentMapper;
    }

    @PostMapping
    public ResponseEntity<AgentDTO> upsert(@RequestBody AgentCreateRequestDTO body) {
        var tenant = TenantContext.current();
        var domain = agentMapper.toDomain(body, tenant.orgId());
        var saved = agentService.upsert(domain);
        return ResponseEntity.status(HttpStatus.CREATED).body(agentMapper.toDTO(saved));
    }

    @GetMapping("/{id}")
    public ResponseEntity<AgentDTO> getById(@PathVariable String id) {
        var tenant = TenantContext.current();
        return agentService.findById(tenant.orgId(), id)
            .map(agentMapper::toDTO)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping
    public List<AgentDTO> list(
        @RequestParam(defaultValue = "50") int limit,
        @RequestParam(defaultValue = "0") int offset
    ) {
        var tenant = TenantContext.current();
        return agentService.listByOrg(tenant.orgId(), limit, offset).stream()
            .map(agentMapper::toDTO)
            .toList();
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        var tenant = TenantContext.current();
        boolean removed = agentService.softDelete(tenant.orgId(), id, tenant.userId());
        return removed ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }
}

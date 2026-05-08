package com.jefelabs.agentx.controlplane.catalog.api;

import com.jefelabs.agentx.controlplane.catalog.api.dto.FlowCreateRequestDTO;
import com.jefelabs.agentx.controlplane.catalog.api.dto.FlowDTO;
import com.jefelabs.agentx.controlplane.catalog.api.mapper.FlowMapper;
import com.jefelabs.agentx.controlplane.catalog.service.FlowService;
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
 * Thin HTTP edge for catalog flows. Per layering convention
 * ({@code feedback_controller_service_layering.md}): four lines per method
 * — read tenant, convert DTO → domain via mapper, call service, wrap result
 * back into DTO. No business logic; no persistence calls.
 */
@RestController
@RequestMapping("/api/catalog/flows")
public class FlowController {

    private final FlowService flowService;
    private final FlowMapper flowMapper;

    public FlowController(FlowService flowService, FlowMapper flowMapper) {
        this.flowService = flowService;
        this.flowMapper = flowMapper;
    }

    @PostMapping
    public ResponseEntity<FlowDTO> upsert(@RequestBody FlowCreateRequestDTO body) {
        var tenant = TenantContext.current();
        var domain = flowMapper.toDomain(body, tenant.orgId());
        var saved = flowService.upsert(domain);
        return ResponseEntity.status(HttpStatus.CREATED).body(flowMapper.toDTO(saved));
    }

    @GetMapping("/{id}")
    public ResponseEntity<FlowDTO> getById(@PathVariable String id) {
        var tenant = TenantContext.current();
        return flowService.findById(tenant.orgId(), id)
            .map(flowMapper::toDTO)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping
    public List<FlowDTO> list(
        @RequestParam(defaultValue = "50") int limit,
        @RequestParam(defaultValue = "0") int offset
    ) {
        var tenant = TenantContext.current();
        return flowService.listByOrg(tenant.orgId(), limit, offset).stream()
            .map(flowMapper::toDTO)
            .toList();
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        var tenant = TenantContext.current();
        boolean removed = flowService.softDelete(tenant.orgId(), id, tenant.userId());
        return removed ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }
}

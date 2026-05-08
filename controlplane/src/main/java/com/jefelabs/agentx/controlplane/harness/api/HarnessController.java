package com.jefelabs.agentx.controlplane.harness.api;

import com.jefelabs.agentx.controlplane.core.tenancy.TenantContext;
import com.jefelabs.agentx.controlplane.harness.api.dto.HarnessDTO;
import com.jefelabs.agentx.controlplane.harness.api.dto.HeartbeatRequestDTO;
import com.jefelabs.agentx.controlplane.harness.api.dto.RegisterHarnessRequestDTO;
import com.jefelabs.agentx.controlplane.harness.api.dto.RegisterHarnessResponseDTO;
import com.jefelabs.agentx.controlplane.harness.api.mapper.HarnessMapper;
import com.jefelabs.agentx.controlplane.harness.service.HarnessService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * Thin HTTP edge for harness registration + heartbeat. Per layering convention.
 * Routes mirror prd-harness-module.md F1, F7, F12, F14.
 */
@RestController
@RequestMapping("/api/registry")
public class HarnessController {

    private final HarnessService harnessService;
    private final HarnessMapper harnessMapper;

    public HarnessController(HarnessService harnessService, HarnessMapper harnessMapper) {
        this.harnessService = harnessService;
        this.harnessMapper = harnessMapper;
    }

    @PostMapping("/harnesses")
    public ResponseEntity<RegisterHarnessResponseDTO> register(@RequestBody RegisterHarnessRequestDTO body) {
        var tenant = TenantContext.current();
        var result = harnessService.register(
            tenant.orgId(),
            body.id(),
            body.name(),
            body.version(),
            body.region(),
            body.capabilities(),
            body.endpoints()
        );
        var response = new RegisterHarnessResponseDTO(
            result.harnessId(),
            result.sessionToken(),
            harnessMapper.toDTO(result.harness())
        );
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }

    @PostMapping("/heartbeat")
    public ResponseEntity<HarnessDTO> heartbeat(@RequestBody HeartbeatRequestDTO body) {
        var tenant = TenantContext.current();
        return harnessService.recordHeartbeat(
                tenant.orgId(), body.harnessId(), body.sessionToken(), body.currentLoad()
            )
            .map(harnessMapper::toDTO)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.status(HttpStatus.UNAUTHORIZED).build());
    }

    @GetMapping("/harnesses/{id}")
    public ResponseEntity<HarnessDTO> getById(@PathVariable String id) {
        var tenant = TenantContext.current();
        return harnessService.findById(tenant.orgId(), id)
            .map(harnessMapper::toDTO)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping("/harnesses")
    public List<HarnessDTO> list(
        @RequestParam(defaultValue = "100") int limit,
        @RequestParam(defaultValue = "0") int offset
    ) {
        var tenant = TenantContext.current();
        return harnessService.listActiveByOrg(tenant.orgId(), limit, offset).stream()
            .map(harnessMapper::toDTO)
            .toList();
    }

    @DeleteMapping("/harnesses/{id}")
    public ResponseEntity<Void> deregister(@PathVariable String id) {
        var tenant = TenantContext.current();
        boolean removed = harnessService.deregister(tenant.orgId(), id);
        return removed ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }
}

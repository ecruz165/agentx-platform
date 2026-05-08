package com.jefelabs.agentx.controlplane.eval.api;

import com.jefelabs.agentx.controlplane.core.tenancy.TenantContext;
import com.jefelabs.agentx.controlplane.eval.api.dto.EvalSuiteDTO;
import com.jefelabs.agentx.controlplane.eval.api.dto.RunSuiteRequestDTO;
import com.jefelabs.agentx.controlplane.eval.api.dto.RunSuiteResponseDTO;
import com.jefelabs.agentx.controlplane.eval.api.dto.UpsertSuiteRequestDTO;
import com.jefelabs.agentx.controlplane.eval.domain.EvalSuite;
import com.jefelabs.agentx.controlplane.eval.service.EvalSuiteService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * Eval-suite CRUD + run trigger. Slice 3 of the eval-harness work.
 */
@RestController
@RequestMapping("/api/evals/suites")
public class EvalSuiteController {

    private final EvalSuiteService service;

    public EvalSuiteController(EvalSuiteService service) {
        this.service = service;
    }

    @PostMapping
    public ResponseEntity<EvalSuiteDTO> upsert(@RequestBody UpsertSuiteRequestDTO body) {
        var tenant = TenantContext.current();
        var suite = new EvalSuite(
            tenant.orgId(), body.id(), body.name(), body.description(),
            body.inputs(), null, null, tenant.userId()
        );
        return ResponseEntity.status(HttpStatus.CREATED).body(toDTO(service.upsert(suite)));
    }

    @GetMapping("/{id}")
    public ResponseEntity<EvalSuiteDTO> getById(@PathVariable String id) {
        var tenant = TenantContext.current();
        return service.findById(tenant.orgId(), id)
            .map(EvalSuiteController::toDTO)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping
    public List<EvalSuiteDTO> list(
        @RequestParam(defaultValue = "50") int limit,
        @RequestParam(defaultValue = "0") int offset
    ) {
        var tenant = TenantContext.current();
        return service.listByOrg(tenant.orgId(), limit, offset).stream()
            .map(EvalSuiteController::toDTO)
            .toList();
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        var tenant = TenantContext.current();
        return service.softDelete(tenant.orgId(), id)
            ? ResponseEntity.noContent().build()
            : ResponseEntity.notFound().build();
    }

    @PostMapping("/{id}/run")
    public ResponseEntity<RunSuiteResponseDTO> run(
        @PathVariable String id,
        @RequestBody RunSuiteRequestDTO body
    ) {
        var tenant = TenantContext.current();
        var result = service.run(
            tenant.orgId(), tenant.userId(), id,
            body.flowId(), body.productId(),
            body.label(), body.config()
        );
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(
            new RunSuiteResponseDTO(result.runId(), result.label(), result.jobIds())
        );
    }

    private static EvalSuiteDTO toDTO(EvalSuite suite) {
        return new EvalSuiteDTO(
            suite.id(), suite.name(), suite.description(),
            suite.inputs(),
            suite.createdAt(), suite.updatedAt()
        );
    }
}

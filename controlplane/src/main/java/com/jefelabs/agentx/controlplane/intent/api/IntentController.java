package com.jefelabs.agentx.controlplane.intent.api;

import com.jefelabs.agentx.controlplane.core.tenancy.TenantContext;
import com.jefelabs.agentx.controlplane.core.types.JobIntent;
import com.jefelabs.agentx.controlplane.intent.api.dto.ConfirmRequestDTO;
import com.jefelabs.agentx.controlplane.intent.api.dto.IntentSessionDTO;
import com.jefelabs.agentx.controlplane.intent.api.dto.MessageRequestDTO;
import com.jefelabs.agentx.controlplane.intent.api.dto.StartSessionRequestDTO;
import com.jefelabs.agentx.controlplane.intent.api.mapper.IntentSessionMapper;
import com.jefelabs.agentx.controlplane.intent.service.IntentService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

/**
 * HTTP edge for the Intent module. Phase 5 surface:
 *   POST   /api/intent/sessions           — start an intake session
 *   GET    /api/intent/sessions/{id}      — read session state
 *   GET    /api/intent/sessions           — list sessions for the org
 *   POST   /api/intent/sessions/{id}/messages — deliver a user turn
 *   POST   /api/intent/sessions/{id}/confirm  — submit the work job
 *   POST   /api/intent/sessions/{id}/abort    — abort the session
 */
@RestController
@RequestMapping("/api/intent")
public class IntentController {

    private final IntentService intentService;
    private final IntentSessionMapper mapper;
    private final String defaultIntakePipelineId;

    public IntentController(
        IntentService intentService,
        IntentSessionMapper mapper,
        @Value("${agentx.intent.default-intake-pipeline:default-intake}") String defaultIntakePipelineId
    ) {
        this.intentService = intentService;
        this.mapper = mapper;
        this.defaultIntakePipelineId = defaultIntakePipelineId;
    }

    @PostMapping("/sessions")
    public ResponseEntity<IntentSessionDTO> startSession(@RequestBody StartSessionRequestDTO body) {
        var tenant = TenantContext.current();
        String pipelineId = body.intakePipelineId() != null ? body.intakePipelineId()
            : defaultIntakePipelineId;
        var session = intentService.startSession(
            tenant.orgId(), tenant.userId(),
            pipelineId, body.productId(), body.initialInput()
        );
        return ResponseEntity.status(HttpStatus.CREATED).body(mapper.toDTO(session));
    }

    @GetMapping("/sessions/{id}")
    public ResponseEntity<IntentSessionDTO> getById(@PathVariable UUID id) {
        var tenant = TenantContext.current();
        return intentService.findById(tenant.orgId(), id)
            .map(mapper::toDTO)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping("/sessions")
    public List<IntentSessionDTO> listByOrg(
        @RequestParam(defaultValue = "50") int limit,
        @RequestParam(defaultValue = "0") int offset
    ) {
        var tenant = TenantContext.current();
        return intentService.listByOrg(tenant.orgId(), limit, offset).stream()
            .map(mapper::toDTO)
            .toList();
    }

    @PostMapping("/sessions/{id}/abort")
    public ResponseEntity<IntentSessionDTO> abort(@PathVariable UUID id) {
        var tenant = TenantContext.current();
        return intentService.abort(tenant.orgId(), id)
            .map(mapper::toDTO)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping("/sessions/{id}/messages")
    public ResponseEntity<IntentSessionDTO> deliverMessage(
        @PathVariable UUID id,
        @RequestBody MessageRequestDTO body
    ) {
        var tenant = TenantContext.current();
        return intentService.deliverMessage(tenant.orgId(), id, body.message())
            .map(mapper::toDTO)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping("/sessions/{id}/confirm")
    public ResponseEntity<IntentSessionDTO> confirm(
        @PathVariable UUID id,
        @RequestBody ConfirmRequestDTO body
    ) {
        var tenant = TenantContext.current();
        var workIntent = new JobIntent(
            body.flowId(), body.productId(), body.input(), body.set(), body.config()
        );
        return intentService.confirm(tenant.orgId(), id, workIntent, tenant.userId())
            .map(mapper::toDTO)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }
}

package com.jefelabs.agentx.controlplane.context.api;

import com.jefelabs.agentx.controlplane.context.api.dto.ChunkDTO;
import com.jefelabs.agentx.controlplane.context.api.dto.ContextSourceDTO;
import com.jefelabs.agentx.controlplane.context.api.dto.IngestionJobDTO;
import com.jefelabs.agentx.controlplane.context.api.dto.QueryRequestDTO;
import com.jefelabs.agentx.controlplane.context.api.dto.RegisterSourceRequestDTO;
import com.jefelabs.agentx.controlplane.context.api.mapper.ContextSourceMapper;
import com.jefelabs.agentx.controlplane.context.service.ContextService;
import com.jefelabs.agentx.controlplane.context.service.QueryService;
import com.jefelabs.agentx.controlplane.core.tenancy.TenantContext;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * Thin HTTP edge for the context module's source registry. Phase 4.1
 * ships CRUD; query (POST /query) lands at Phase 4.2 with Neo4j-backed
 * vector search; manual refresh (POST /sources/{id}/refresh) lands at
 * Phase 4.3 with the ingestion subprocess.
 */
@RestController
@RequestMapping("/api/context")
public class ContextController {

    private final ContextService contextService;
    private final ContextSourceMapper mapper;
    private final QueryService queryService;

    public ContextController(ContextService contextService, ContextSourceMapper mapper, QueryService queryService) {
        this.contextService = contextService;
        this.mapper = mapper;
        this.queryService = queryService;
    }

    @PostMapping("/sources")
    public ResponseEntity<ContextSourceDTO> register(@RequestBody RegisterSourceRequestDTO body) {
        var tenant = TenantContext.current();
        var domain = mapper.toDomain(body, tenant.orgId());
        // Inject createdBy via a fresh record copy since the mapper ignored it
        var withActor = new com.jefelabs.agentx.controlplane.context.domain.ContextSource(
            domain.orgId(), domain.id(), domain.kind(), domain.target(),
            domain.profile(), domain.refreshSchedule(), domain.accessPolicy(),
            domain.createdAt(), domain.updatedAt(), tenant.userId()
        );
        var saved = contextService.registerSource(withActor);
        return ResponseEntity.status(HttpStatus.CREATED).body(mapper.toDTO(saved));
    }

    @GetMapping("/sources/{id}")
    public ResponseEntity<ContextSourceDTO> getById(@PathVariable String id) {
        var tenant = TenantContext.current();
        return contextService.findById(tenant.orgId(), id)
            .map(mapper::toDTO)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping("/sources")
    public List<ContextSourceDTO> list(
        @RequestParam(defaultValue = "100") int limit,
        @RequestParam(defaultValue = "0") int offset
    ) {
        var tenant = TenantContext.current();
        return contextService.listByOrg(tenant.orgId(), limit, offset).stream()
            .map(mapper::toDTO)
            .toList();
    }

    @DeleteMapping("/sources/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        var tenant = TenantContext.current();
        boolean removed = contextService.softDelete(tenant.orgId(), id);
        return removed ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }

    @GetMapping("/sources/{id}/ingestions")
    public List<IngestionJobDTO> listIngestions(
        @PathVariable String id,
        @RequestParam(defaultValue = "20") int limit
    ) {
        var tenant = TenantContext.current();
        return contextService.listIngestionsBySource(tenant.orgId(), id, limit).stream()
            .map(mapper::toDTO)
            .toList();
    }

    /**
     * Vector-search query — embed text, search Neo4j, return ranked chunks
     * filtered by access policy. Per prd-context-module.md F7-F12.
     */
    @PostMapping("/query")
    public ResponseEntity<List<ChunkDTO>> query(@RequestBody QueryRequestDTO body) {
        var tenant = TenantContext.current();
        try {
            List<ChunkDTO> hits = queryService.query(
                tenant.orgId(),
                body.text(),
                body.productId(),
                body.k(),
                body.sources()
            );
            return ResponseEntity.ok(hits);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().build();
        }
    }
}

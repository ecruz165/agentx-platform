package com.jefelabs.agentx.controlplane.catalog.api;

import com.jefelabs.agentx.controlplane.catalog.api.dto.CatalogItemDTO;
import com.jefelabs.agentx.controlplane.catalog.domain.CatalogItem;
import com.jefelabs.agentx.controlplane.catalog.domain.CatalogItemType;
import com.jefelabs.agentx.controlplane.catalog.service.CatalogItemService;
import com.jefelabs.agentx.controlplane.core.tenancy.TenantContext;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * Read API for the unified catalog. Phase B ships read-only — sync
 * writes via the build-time seed loaded by {@code CatalogBootstrap}.
 * User-authoring endpoints (POST / PUT) land when an agent-builder UI
 * needs them.
 */
@RestController
@RequestMapping("/api/catalog/items")
public class CatalogItemController {

    private final CatalogItemService service;

    public CatalogItemController(CatalogItemService service) {
        this.service = service;
    }

    @GetMapping
    public List<CatalogItemDTO> list(
        @RequestParam(required = false) CatalogItemType type,
        @RequestParam(defaultValue = "100") int limit,
        @RequestParam(defaultValue = "0") int offset
    ) {
        var tenant = TenantContext.current();
        return service.listByOrg(tenant.orgId(), type, limit, offset).stream()
            .map(CatalogItemController::toDTO)
            .toList();
    }

    @GetMapping("/{type}/{id:.+}")
    public ResponseEntity<CatalogItemDTO> getById(
        @PathVariable CatalogItemType type,
        @PathVariable String id
    ) {
        var tenant = TenantContext.current();
        return service.findById(tenant.orgId(), type, id)
            .map(CatalogItemController::toDTO)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }

    private static CatalogItemDTO toDTO(CatalogItem item) {
        return new CatalogItemDTO(
            item.type(), item.id(), item.name(), item.version(),
            item.description(), item.topic(), item.tags(),
            item.runtime(), item.manifest(), item.source(),
            item.createdAt(), item.updatedAt()
        );
    }
}

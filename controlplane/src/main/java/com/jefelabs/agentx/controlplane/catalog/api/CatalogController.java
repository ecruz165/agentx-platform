package com.jefelabs.agentx.controlplane.catalog.api;

import com.jefelabs.agentx.controlplane.catalog.api.dto.CatalogDTO;
import com.jefelabs.agentx.controlplane.catalog.api.mapper.AgentMapper;
import com.jefelabs.agentx.controlplane.catalog.api.mapper.FlowMapper;
import com.jefelabs.agentx.controlplane.catalog.api.mapper.ProductMapper;
import com.jefelabs.agentx.controlplane.catalog.api.mapper.SkillMapper;
import com.jefelabs.agentx.controlplane.catalog.service.AgentService;
import com.jefelabs.agentx.controlplane.catalog.service.FlowService;
import com.jefelabs.agentx.controlplane.catalog.service.ProductService;
import com.jefelabs.agentx.controlplane.catalog.service.SkillService;
import com.jefelabs.agentx.controlplane.core.tenancy.TenantContext;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Aggregate catalog endpoint — returns the full org-scoped catalog
 * (flows + agents + skills + products) in a single response, mirroring
 * the TS-side {@code loadCatalog()} contract from
 * {@code harness-core/src/catalog.ts}.
 *
 * <p>Per layering convention this controller is still thin — it composes
 * four service calls + four mappers, no business logic. The catalog is
 * read-heavy + write-rare, so an unpaginated full fetch is acceptable
 * (high LIMIT 1000 caps each entity to defend against runaway data).
 */
@RestController
@RequestMapping("/api/catalog")
public class CatalogController {

    private static final int FULL_LIMIT = 1000;

    private final FlowService flowService;
    private final AgentService agentService;
    private final SkillService skillService;
    private final ProductService productService;

    private final FlowMapper flowMapper;
    private final AgentMapper agentMapper;
    private final SkillMapper skillMapper;
    private final ProductMapper productMapper;

    public CatalogController(
        FlowService flowService,
        AgentService agentService,
        SkillService skillService,
        ProductService productService,
        FlowMapper flowMapper,
        AgentMapper agentMapper,
        SkillMapper skillMapper,
        ProductMapper productMapper
    ) {
        this.flowService = flowService;
        this.agentService = agentService;
        this.skillService = skillService;
        this.productService = productService;
        this.flowMapper = flowMapper;
        this.agentMapper = agentMapper;
        this.skillMapper = skillMapper;
        this.productMapper = productMapper;
    }

    @GetMapping("/full")
    public CatalogDTO getFull() {
        var orgId = TenantContext.current().orgId();
        return new CatalogDTO(
            flowService.listByOrg(orgId, FULL_LIMIT, 0).stream().map(flowMapper::toDTO).toList(),
            agentService.listByOrg(orgId, FULL_LIMIT, 0).stream().map(agentMapper::toDTO).toList(),
            skillService.listByOrg(orgId, FULL_LIMIT, 0).stream().map(skillMapper::toDTO).toList(),
            productService.listByOrg(orgId, FULL_LIMIT, 0).stream().map(productMapper::toDTO).toList()
        );
    }
}

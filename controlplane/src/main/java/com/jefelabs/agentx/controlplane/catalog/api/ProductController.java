package com.jefelabs.agentx.controlplane.catalog.api;

import com.jefelabs.agentx.controlplane.catalog.api.dto.ProductCreateRequestDTO;
import com.jefelabs.agentx.controlplane.catalog.api.dto.ProductDTO;
import com.jefelabs.agentx.controlplane.catalog.api.mapper.ProductMapper;
import com.jefelabs.agentx.controlplane.catalog.service.ProductService;
import com.jefelabs.agentx.controlplane.core.tenancy.TenantContext;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/catalog/products")
public class ProductController {

    private final ProductService productService;
    private final ProductMapper productMapper;

    public ProductController(ProductService productService, ProductMapper productMapper) {
        this.productService = productService;
        this.productMapper = productMapper;
    }

    @PostMapping
    public ResponseEntity<ProductDTO> upsert(@RequestBody ProductCreateRequestDTO body) {
        var tenant = TenantContext.current();
        var domain = productMapper.toDomain(body, tenant.orgId());
        var saved = productService.upsert(domain);
        return ResponseEntity.status(HttpStatus.CREATED).body(productMapper.toDTO(saved));
    }

    @GetMapping("/{id}")
    public ResponseEntity<ProductDTO> getById(@PathVariable String id) {
        var tenant = TenantContext.current();
        return productService.findById(tenant.orgId(), id)
            .map(productMapper::toDTO)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping
    public List<ProductDTO> list(
        @RequestParam(defaultValue = "50") int limit,
        @RequestParam(defaultValue = "0") int offset
    ) {
        var tenant = TenantContext.current();
        return productService.listByOrg(tenant.orgId(), limit, offset).stream()
            .map(productMapper::toDTO)
            .toList();
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        var tenant = TenantContext.current();
        boolean removed = productService.softDelete(tenant.orgId(), id, tenant.userId());
        return removed ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }
}

package com.jefelabs.agentx.controlplane.catalog.service;

import com.jefelabs.agentx.controlplane.catalog.domain.Product;
import com.jefelabs.agentx.controlplane.catalog.persistence.ProductDao;
import com.jefelabs.agentx.controlplane.catalog.persistence.ProductDaoRow;
import org.jdbi.v3.core.Jdbi;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Optional;

@Service
public class ProductService {

    private final Jdbi jdbi;
    private final ObjectMapper objectMapper;

    public ProductService(Jdbi jdbi, ObjectMapper objectMapper) {
        this.jdbi = jdbi;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public Product upsert(Product product) {
        ProductDao dao = jdbi.onDemand(ProductDao.class);
        dao.upsert(
            product.orgId(),
            product.id(),
            product.description(),
            writeJson(product.contextSources()),
            writeJson(product.repos()),
            product.createdBy()
        );
        return dao.findById(product.orgId(), product.id())
            .map(this::toDomain)
            .orElseThrow(() -> new IllegalStateException("Upsert succeeded but row not found: " + product.id()));
    }

    public Optional<Product> findById(String orgId, String id) {
        return jdbi.onDemand(ProductDao.class).findById(orgId, id).map(this::toDomain);
    }

    public List<Product> listByOrg(String orgId, int limit, int offset) {
        return jdbi.onDemand(ProductDao.class).listByOrg(orgId, limit, offset).stream()
            .map(this::toDomain)
            .toList();
    }

    @Transactional
    public boolean softDelete(String orgId, String id, String deletedBy) {
        return jdbi.onDemand(ProductDao.class).softDelete(orgId, id, deletedBy) > 0;
    }

    private Product toDomain(ProductDaoRow row) {
        return new Product(
            row.orgId(), row.id(), row.description(),
            readJson(row.contextSources()), readJson(row.repos()),
            row.createdAt(), row.updatedAt(), row.createdBy(), row.updatedBy()
        );
    }

    private JsonNode readJson(String json) {
        if (json == null) return null;
        try { return objectMapper.readTree(json); }
        catch (JacksonException e) { throw new IllegalStateException("Stored JSON parse failed", e); }
    }

    private String writeJson(JsonNode node) {
        if (node == null) return null;
        try { return objectMapper.writeValueAsString(node); }
        catch (JacksonException e) { throw new IllegalArgumentException("Failed to serialize JsonNode", e); }
    }
}

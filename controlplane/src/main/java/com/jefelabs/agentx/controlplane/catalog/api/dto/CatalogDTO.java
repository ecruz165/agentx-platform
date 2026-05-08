package com.jefelabs.agentx.controlplane.catalog.api.dto;

import java.util.List;

/**
 * Aggregate catalog view returned by {@code GET /api/catalog/full} — the
 * controlplane equivalent of TS-side {@code loadCatalog()} from
 * {@code harness-core/src/catalog.ts}.
 *
 * <p>Bundles the four entity types in a single response so a harness can
 * fetch the entire catalog for its org in one HTTP call at startup +
 * periodically refresh. ETag-based conditional requests (catalog module
 * PRD §6.4 / F23) lands in Phase 1.x.
 */
public record CatalogDTO(
    List<FlowDTO> flows,
    List<AgentDTO> agents,
    List<SkillDTO> skills,
    List<ProductDTO> products
) {
}

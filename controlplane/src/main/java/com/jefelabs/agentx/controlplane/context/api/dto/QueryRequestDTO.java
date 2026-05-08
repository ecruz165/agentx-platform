package com.jefelabs.agentx.controlplane.context.api.dto;

import java.util.List;

/**
 * Wire format for {@code POST /api/context/query}. Per prd-context-module.md F7:
 *   { text, productId, k=10, sources? }
 */
public record QueryRequestDTO(
    String text,
    String productId,
    Integer k,
    List<String> sources
) {
}

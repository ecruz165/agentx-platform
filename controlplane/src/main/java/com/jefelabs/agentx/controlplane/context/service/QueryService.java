package com.jefelabs.agentx.controlplane.context.service;

import com.jefelabs.agentx.controlplane.context.api.dto.ChunkDTO;
import com.jefelabs.agentx.controlplane.context.domain.ContextSource;
import com.jefelabs.agentx.controlplane.context.integration.EmbedderClient;
import com.jefelabs.agentx.controlplane.context.integration.Neo4jChunkRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Composes the embedder + Neo4j query + access-policy filter into the
 * {@code POST /api/context/query} flow.
 *
 * <p>Per prd-context-module.md F10: queries are scoped to the calling org;
 * within an org, only sources whose {@code accessPolicy.allowedProductIds}
 * include the calling productId (or "all") are considered. The optional
 * {@code sources} parameter on the request narrows further.
 */
@Service
public class QueryService {

    private static final Logger log = LoggerFactory.getLogger(QueryService.class);
    private static final int DEFAULT_K = 10;

    private final EmbedderClient embedderClient;
    private final Neo4jChunkRepository chunkRepository;
    private final ContextService contextService;
    private final ObjectMapper objectMapper;

    public QueryService(
        EmbedderClient embedderClient,
        Neo4jChunkRepository chunkRepository,
        ContextService contextService,
        ObjectMapper objectMapper
    ) {
        this.embedderClient = embedderClient;
        this.chunkRepository = chunkRepository;
        this.contextService = contextService;
        this.objectMapper = objectMapper;
    }

    public List<ChunkDTO> query(
        String orgId,
        String text,
        String productId,
        Integer k,
        List<String> requestedSources
    ) {
        if (text == null || text.isBlank()) {
            throw new IllegalArgumentException("query.text is required");
        }
        int limit = (k != null && k > 0) ? k : DEFAULT_K;

        List<String> allowedSources = resolveAllowedSources(orgId, productId, requestedSources);
        if (allowedSources != null && allowedSources.isEmpty()) {
            log.debug("Query for org={} product={} has no accessible sources", orgId, productId);
            return List.of();
        }

        List<Double> queryVector = embedderClient.embed(text);

        var hits = chunkRepository.queryByVector(queryVector, limit, allowedSources);

        List<ChunkDTO> dtos = new ArrayList<>(hits.size());
        for (var hit : hits) {
            JsonNode metadata = hit.properties() != null && !hit.properties().isEmpty()
                ? objectMapper.valueToTree(hit.properties())
                : null;
            dtos.add(new ChunkDTO(hit.text(), hit.score(), hit.sourceId(), metadata));
        }
        return dtos;
    }

    /**
     * Resolve which sourceIds the calling product can read. Returns null when
     * no filtering is needed (productId access spans every source); empty list
     * means "no accessible sources" (caller short-circuits to empty result).
     */
    private List<String> resolveAllowedSources(String orgId, String productId, List<String> requestedSources) {
        // Read all org sources + filter by accessPolicy.
        var orgSources = contextService.listByOrg(orgId, 1000, 0);
        Set<String> requestedFilter = requestedSources != null && !requestedSources.isEmpty()
            ? Set.copyOf(requestedSources)
            : null;

        List<String> allowed = new ArrayList<>(orgSources.size());
        for (ContextSource src : orgSources) {
            if (requestedFilter != null && !requestedFilter.contains(src.id())) continue;
            if (productCanAccess(src, productId)) {
                allowed.add(src.id());
            }
        }
        return allowed;
    }

    private boolean productCanAccess(ContextSource source, String productId) {
        JsonNode policy = source.accessPolicy();
        if (policy == null) return true;  // no policy → open
        JsonNode allowedIds = policy.path("allowedProductIds");
        if (allowedIds.isMissingNode() || allowedIds.isNull()) return true;
        if (allowedIds.isTextual() && "all".equals(allowedIds.asText())) return true;
        if (allowedIds.isArray()) {
            for (JsonNode entry : allowedIds) {
                if (entry.isTextual() && entry.asText().equals(productId)) return true;
            }
            return false;
        }
        // Unknown shape → conservative reject.
        log.warn("Unknown accessPolicy.allowedProductIds shape on source {}: {}", source.id(), allowedIds);
        return false;
    }
}

package com.jefelabs.agentx.controlplane.context.integration;

import com.fasterxml.jackson.annotation.JsonProperty;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.util.List;

/**
 * Thin client for the OpenAI-compatible /v1/embeddings endpoint. The
 * compose-provided huggingface/text-embeddings-inference service speaks
 * this protocol; so do Bedrock proxies, OpenAI direct, hosted TEI, etc.
 *
 * <p>Configured via {@code agentx.embedder.*} in application.yml; the
 * URL points at the {@code /v1} root (the {@code /embeddings} suffix is
 * appended by this client).
 *
 * <p>Phase 4.2 uses this for query-time embedding only; Phase 4.3's
 * agentx-load CLI handles ingestion-time embedding directly via its own
 * embedder client (passed in via --embedder-url), so this class doesn't
 * need to be on the ingestion hot path.
 */
@Component
public class EmbedderClient {

    private static final Logger log = LoggerFactory.getLogger(EmbedderClient.class);

    private final RestClient restClient;
    private final String model;
    private final int expectedDim;

    public EmbedderClient(
        @Value("${agentx.embedder.url:http://localhost:8081}") String baseUrl,
        @Value("${agentx.embedder.model:BAAI/bge-small-en-v1.5}") String model,
        @Value("${agentx.embedder.dimension:384}") int expectedDim
    ) {
        this.restClient = RestClient.builder().baseUrl(baseUrl).build();
        this.model = model;
        this.expectedDim = expectedDim;
        log.info("EmbedderClient configured: url={} model={} dim={}", baseUrl, model, expectedDim);
    }

    /**
     * Embed a single text input. Returns the vector as a list of doubles
     * (Neo4j's vector procedures accept this shape; Java conversion to
     * float[] happens at the Cypher boundary).
     */
    public List<Double> embed(String text) {
        EmbeddingRequest request = new EmbeddingRequest(text, model);
        EmbeddingResponse response = restClient.post()
            .uri("/v1/embeddings")
            .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
            .body(request)
            .retrieve()
            .body(EmbeddingResponse.class);

        if (response == null || response.data() == null || response.data().isEmpty()) {
            throw new IllegalStateException("embedder returned no data");
        }
        List<Double> embedding = response.data().get(0).embedding();
        if (embedding.size() != expectedDim) {
            log.warn("embedder returned dim={} (expected {})", embedding.size(), expectedDim);
        }
        return embedding;
    }

    // ── DTOs (private to this client) ─────────────────────────────────────

    /** OpenAI-compatible request body. */
    public record EmbeddingRequest(String input, String model) {}

    /** OpenAI-compatible response envelope. */
    public record EmbeddingResponse(List<EmbeddingDatum> data, String model, Usage usage) {}

    public record EmbeddingDatum(
        @JsonProperty("object") String object,
        int index,
        List<Double> embedding
    ) {}

    public record Usage(@JsonProperty("prompt_tokens") int promptTokens,
                        @JsonProperty("total_tokens") int totalTokens) {}
}

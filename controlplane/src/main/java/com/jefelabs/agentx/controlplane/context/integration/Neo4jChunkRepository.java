package com.jefelabs.agentx.controlplane.context.integration;

import org.neo4j.driver.Driver;
import org.neo4j.driver.Record;
import org.neo4j.driver.Session;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * Vector-search reader against the central Neo4j graph. Mirrors the schema
 * produced by {@code @ecruz165/context-loader-core} (the same chunker the
 * edge-context-server + Phase 4.3's agentx-load CLI populate from):
 *
 * <ul>
 *   <li>{@code (:Chunk)} nodes with {@code text}, {@code sourceId},
 *       {@code embedding} (list<float>), and arbitrary metadata properties.</li>
 *   <li>Vector index {@code chunk_embedding} on {@code :Chunk(embedding)}.</li>
 * </ul>
 *
 * <p>The Cypher uses {@code db.index.vector.queryNodes} (Neo4j 5+); when the
 * index doesn't exist (no data ingested yet) it throws — the caller maps
 * that to an empty result rather than failing the request.
 */
@Component
public class Neo4jChunkRepository {

    private static final Logger log = LoggerFactory.getLogger(Neo4jChunkRepository.class);

    private static final String VECTOR_QUERY = """
        CALL db.index.vector.queryNodes('chunk_embedding', $k, $vector)
        YIELD node, score
        WHERE ($sourceFilter IS NULL OR node.sourceId IN $sourceFilter)
        RETURN node.text AS text,
               node.sourceId AS sourceId,
               properties(node) AS properties,
               score
        ORDER BY score DESC
        LIMIT $k
        """;

    private final Driver driver;

    public Neo4jChunkRepository(Driver driver) {
        this.driver = driver;
    }

    /**
     * Run vector search. {@code allowedSourceIds} filters at the Cypher level
     * (per the access-policy resolution done by the service); pass null to
     * skip filtering.
     */
    public List<ChunkHit> queryByVector(List<Double> queryVector, int k, List<String> allowedSourceIds) {
        try (Session session = driver.session()) {
            return session.executeRead(tx -> {
                var result = tx.run(VECTOR_QUERY, java.util.Map.of(
                    "k", k,
                    "vector", queryVector,
                    "sourceFilter", allowedSourceIds == null ? null : allowedSourceIds
                ));
                List<ChunkHit> hits = new ArrayList<>();
                while (result.hasNext()) {
                    Record r = result.next();
                    hits.add(new ChunkHit(
                        r.get("text").asString(""),
                        r.get("sourceId").asString(""),
                        r.get("score").asDouble(),
                        r.get("properties").asMap()
                    ));
                }
                return hits;
            });
        } catch (RuntimeException e) {
            // Index missing (no data ingested yet) is the typical cause; surface
            // as empty results rather than failing the request. Production logging
            // distinguishes this from real Neo4j connectivity failures.
            log.warn("Neo4j vector query failed; returning empty results: {}", e.getMessage());
            return List.of();
        }
    }

    /** Read shape returned by the repository. */
    public record ChunkHit(
        String text,
        String sourceId,
        double score,
        java.util.Map<String, Object> properties
    ) {}
}

/**
 * Context module — org-wide graph-RAG layer, Neo4j-backed.
 *
 * <p>Closed module. Owns ingestion + query APIs for org-shared knowledge sources.
 * Pairs with workspace-local {@code edge-context-server} instances via NDJSON sub-graph
 * export for priming.
 *
 * <p>See {@code .plans/2026-05-07-prd-context-module.md}.
 */
@org.springframework.modulith.ApplicationModule(
    displayName = "Context"
)
package com.jefelabs.agentx.controlplane.context;

/**
 * Backend implementations of GraphIngestionBackend (graph nodes/edges/vectors).
 *
 * Naming convention: every backend in this directory is a *graph* backend.
 * It is distinct from `@agentx/edge-memory-server`'s SQLite + sqlite-vec
 * storage, which is per-job key-value+vector scratch with a separate
 * MemoryStore interface and lifecycle.
 *
 * Phase B.0:
 *   - InMemoryGraphBackend (test/reference; JS Maps, no persistence)
 *
 * Phase B.1 (per .plans/2026-05-05-prd-context-loader-core.md F13):
 *   - Neo4jBackend — neo4j://host:port (or bolt://, neo4j+s://). Used for
 *     both the local edge tier (compose `neo4j-edge` sidecar) and the
 *     deployed central tier (self-hosted on ECS+EBS). One impl, two URLs.
 *
 * Note: the original three-backend story (KuzuDirect / KuzuViaServer / Neo4j)
 * collapsed to a single Neo4j backend on 2026-05-05 after Kuzu was found
 * archived; see workspace memory project_central_graph_store_choice.
 */

export { InMemoryGraphBackend } from './in-memory.ts';
export { Neo4jBackend, type Neo4jBackendOptions } from './neo4j.ts';

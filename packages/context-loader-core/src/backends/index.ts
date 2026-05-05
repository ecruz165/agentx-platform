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
 * Phase B.1+ (per .plans/2026-05-05-prd-context-loader-core.md F13):
 *   - KuzuDirectGraphBackend       — kuzu://path
 *   - KuzuViaServerGraphBackend    — kuzu+uds:///path or kuzu+http://host
 *   - Neo4jGraphBackend            — neo4j://host:port
 */

export { InMemoryGraphBackend } from './in-memory.ts';

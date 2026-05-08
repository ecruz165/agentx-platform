/**
 * edge-server launcher — runs the two TS peer servers (edge-context-server +
 * edge-memory-server) inside the edge-server container, alongside the
 * container's private Neo4j.
 *
 * Both servers expose Unix Domain Sockets in EDGE_SOCKETS_DIR (default
 * /run/edge); harness-server reaches them via the same path through a
 * shared compose volume.
 *
 * Configuration via env:
 *   EDGE_SOCKETS_DIR   — UDS socket directory (default /run/edge)
 *   EDGE_NEO4J_URL     — bolt URL for the in-container neo4j (default bolt://localhost:7687)
 *   EDGE_NEO4J_USER    — default 'neo4j'
 *   EDGE_NEO4J_PASSWORD
 *   AGENTX_EMBEDDER_URL    — OpenAI-compat /v1 root (injected by Model Runner attachment)
 *   AGENTX_EMBEDDER_MODEL  — e.g. ai/qwen3-embedding:0.6B-F16
 *   AGENTX_EMBEDDER_DIMENSION — e.g. 1024
 *
 * If the embedder env vars are missing, edge-context's query falls back
 * to echo mode (no real vector search) — matches the existing
 * examples/04-server-trio.ts behavior.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ContextQueryService, startContextServer } from '@ecruz165/edge-context-server';
import { startMemoryServer } from '@ecruz165/edge-memory-server';

const sockDir = process.env.EDGE_SOCKETS_DIR ?? '/run/edge';
mkdirSync(sockDir, { recursive: true });

// Clear stale sockets from a prior crash so binds succeed.
for (const name of ['memory.sock', 'context.sock']) {
  try {
    rmSync(join(sockDir, name));
  } catch {
    /* not present, fine */
  }
}

const memorySocket = join(sockDir, 'memory.sock');
const contextSocket = join(sockDir, 'context.sock');

let queryService: ContextQueryService | undefined;
const neoUrl = process.env.EDGE_NEO4J_URL ?? 'bolt://localhost:7687';
const neoPassword = process.env.EDGE_NEO4J_PASSWORD;
const embedderUrl = process.env.AGENTX_EMBEDDER_URL;
if (neoPassword && embedderUrl) {
  queryService = new ContextQueryService({
    neo4jUrl: neoUrl,
    neo4jUser: process.env.EDGE_NEO4J_USER ?? 'neo4j',
    neo4jPassword: neoPassword,
    embedderUrl,
    embedderModel: process.env.AGENTX_EMBEDDER_MODEL ?? 'ai/qwen3-embedding:0.6B-F16',
    embedderDim: process.env.AGENTX_EMBEDDER_DIMENSION
      ? Number(process.env.AGENTX_EMBEDDER_DIMENSION)
      : 1024,
  });
}

const memorySrv = await startMemoryServer({ socketPath: memorySocket });
const contextSrv = await startContextServer({
  socketPath: contextSocket,
  query: queryService,
});

console.log(`[edge-server] memory  → ${memorySocket}`);
console.log(
  `[edge-server] context → ${contextSocket}` +
    (queryService ? '  (real vector search)' : '  (echo — embedder not configured)'),
);
console.log('[edge-server] ready; SIGTERM to stop');

const shutdown = async () => {
  console.log('[edge-server] shutdown…');
  await memorySrv.stop().catch(() => {});
  await contextSrv.stop().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

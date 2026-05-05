import { join } from 'node:path';
import {
  startHarnessServer,
  loadCatalogFromWorkspaceYaml,
} from '@agentx/harness-server';
import { startMemoryServer } from '@agentx/edge-memory-server';
import { startContextServer, ContextQueryService } from '@agentx/edge-context-server';

const SOCKET_DIR = join(process.cwd(), '.harness', 'run');
const harnessSocket = join(SOCKET_DIR, 'harness.sock');
const memorySocket = join(SOCKET_DIR, 'memory.sock');
const contextSocket = join(SOCKET_DIR, 'context.sock');

// Optional: wire real Neo4j vector search into edge-context-server's
// /v1/context/query when the env vars are present. Without them, the
// route falls back to echo (the v0 contract). Useful for smoke tests
// that don't yet have a Neo4j sidecar reachable.
//
// Setup the env once per workspace:
//   export NEO4J_URL=bolt://localhost:7687
//   export NEO4J_PASSWORD=devpassword
//   export EMBEDDER_URL=http://localhost:12434/engines/llama.cpp/v1
//   export EMBEDDER_MODEL=ai/qwen3-embedding:0.6B-F16
let queryService: ContextQueryService | undefined;
if (process.env.NEO4J_URL && process.env.NEO4J_PASSWORD && process.env.EMBEDDER_URL) {
  queryService = new ContextQueryService({
    neo4jUrl: process.env.NEO4J_URL,
    neo4jUser: process.env.NEO4J_USER ?? 'neo4j',
    neo4jPassword: process.env.NEO4J_PASSWORD,
    embedderUrl: process.env.EMBEDDER_URL,
    embedderModel: process.env.EMBEDDER_MODEL ?? 'ai/qwen3-embedding:0.6B-F16',
    embedderDim: process.env.EMBEDDER_DIM ? Number(process.env.EMBEDDER_DIM) : 1024,
  });
}

// Local-dev catalog: stitch harness-workspace.yml products + pipelines.json
// pipelines into the unified Catalog. Operators on ECS would swap this for
// `() => fetchFromCentralCatalog(...)` or `() => readS3Object(...)` — the
// server doesn't care where the catalog comes from, only that loadCatalog()
// resolves before traffic is accepted.
const harnessSrv = await startHarnessServer({
  socketPath: harnessSocket,
  loadCatalog: () => loadCatalogFromWorkspaceYaml(process.cwd()),
});
const memorySrv = await startMemoryServer({ socketPath: memorySocket });
const contextSrv = await startContextServer({
  socketPath: contextSocket,
  query: queryService,
});

console.log('All three peer servers started:');
console.log(`  harness  → ${harnessSocket}`);
console.log(`  memory   → ${memorySocket}`);
console.log(`  context  → ${contextSocket}${queryService ? '  (real vector search)' : '  (echo)'}`);
console.log('');
console.log('In another terminal, try:');
console.log('  pnpm harness server status');
console.log('  pnpm harness auth login github-copilot');
console.log('  pnpm harness auth status');
if (queryService) {
  console.log('  pnpm harness context query "how do agents subscribe to events"');
  console.log('  pnpm harness context load --product agentx-dev \\');
  console.log('    --backend bolt://localhost:7687 --backend-password devpassword \\');
  console.log('    --embedder-url http://localhost:12434/engines/llama.cpp/v1 \\');
  console.log('    --embedder-model ai/qwen3-embedding:0.6B-F16');
  console.log('  pnpm harness jobs-tui     # watch the loader live');
} else {
  console.log('  (set NEO4J_URL + NEO4J_PASSWORD + EMBEDDER_URL to enable real query/load)');
}
console.log('');
console.log('Press Ctrl+C to stop.');

const shutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}, stopping servers…`);
  await Promise.all([harnessSrv.stop(), memorySrv.stop(), contextSrv.stop()]);
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await new Promise(() => {});

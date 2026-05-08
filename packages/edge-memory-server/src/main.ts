/**
 * Edge memory server entrypoint. Selects the backend at startup based
 * on env:
 *
 *   MEMORY_DB_PATH   — when set, opens a SqliteVecMemoryStore at this
 *                      path (the production default per PRD F10).
 *                      ":memory:" for transient in-process.
 *   MEMORY_VECTOR_DIM — vector dimension for sqlite-vec schema. Must
 *                      match the embedder's output. Default 1024
 *                      (matches qwen3-embedding:0.6B-F16).
 *   MEMORY_EMBEDDER_URL  — OpenAI-compat /v1 endpoint for the embedder.
 *                          Required when MEMORY_DB_PATH is set.
 *   MEMORY_EMBEDDER_MODEL — Embedder model id.
 *                           Default 'ai/qwen3-embedding:0.6B-F16'.
 *
 * When MEMORY_DB_PATH is unset, falls back to the in-memory store —
 * useful for tests, dev bringup, and any environment where sqlite-vec's
 * native binary isn't available.
 */

import {
  InMemoryMemoryStore,
  type MemoryStore,
  SqliteVecMemoryStore,
  startMemoryServer,
} from './index.ts';

const socketPath = process.env.MEMORY_SOCKET_PATH ?? '/root/.harness/run/memory.sock';

const store: MemoryStore = await pickBackend();

console.log(`Starting @ecruz165/edge-memory-server on ${socketPath}…`);
console.log(`  backend: ${store.constructor.name}`);

const handle = await startMemoryServer({ socketPath, store });
console.log(`✓ edge-memory-server listening on ${socketPath}`);

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}, stopping edge-memory-server…`);
  await handle.stop();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

await new Promise(() => {});

async function pickBackend(): Promise<MemoryStore> {
  const dbPath = process.env.MEMORY_DB_PATH;
  if (!dbPath) {
    console.log('  (no MEMORY_DB_PATH set; using in-memory backend)');
    return new InMemoryMemoryStore();
  }
  const vectorDim = Number(process.env.MEMORY_VECTOR_DIM ?? '1024');
  const embedderUrl = process.env.MEMORY_EMBEDDER_URL;
  if (!embedderUrl) {
    throw new Error('MEMORY_EMBEDDER_URL required when MEMORY_DB_PATH is set');
  }
  const embedderModel = process.env.MEMORY_EMBEDDER_MODEL ?? 'ai/qwen3-embedding:0.6B-F16';

  // Lazy-import the embedder client to avoid pulling its deps when the
  // in-memory backend is in use.
  const { createHttpEmbedderClient } = await import('@ecruz165/context-loader-core');
  const embedder = createHttpEmbedderClient({
    config: { url: embedderUrl, model: embedderModel, dim: vectorDim },
  });

  return SqliteVecMemoryStore.open({
    dbPath,
    vectorDim,
    embed: (texts) => embedder.embed(texts).then((arrs) => arrs.map((a) => Array.from(a))),
  });
}

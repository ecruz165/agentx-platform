/**
 * Edge memory server entrypoint. Selects backends at startup based on env:
 *
 * Memory store:
 *   MEMORY_DB_PATH        — when set, opens a SqliteVecMemoryStore at this
 *                           path (production default per PRD F10).
 *                           ":memory:" for transient in-process.
 *   MEMORY_VECTOR_DIM     — vector dim. Default 1024 (qwen3-0.6B).
 *   MEMORY_EMBEDDER_URL   — OpenAI-compat /v1 endpoint. Required when
 *                           MEMORY_DB_PATH is set.
 *   MEMORY_EMBEDDER_MODEL — Embedder model. Default ai/qwen3-embedding:0.6B-F16.
 *
 * Audit log (PRD F12):
 *   MEMORY_AUDIT_DB_PATH  — when set, opens a SqliteAuditLog at this path.
 *                           Separate file from MEMORY_DB_PATH by default —
 *                           different retention policies. Unset → falls
 *                           back to InMemoryAuditLog.
 *
 * Listen address:
 *   MEMORY_SOCKET_PATH    — UDS path. Default /root/.harness/run/memory.sock.
 *
 * When MEMORY_DB_PATH is unset, falls back to the in-memory store —
 * useful for tests, dev bringup, and any environment where sqlite-vec's
 * native binary isn't available.
 */

import {
  type AuditLog,
  type IdleThrottleOptions,
  InMemoryAuditLog,
  InMemoryMemoryStore,
  InMemorySnapshotStore,
  type MemoryStore,
  type SnapshotStore,
  SqliteAuditLog,
  SqliteSnapshotStore,
  SqliteVecMemoryStore,
  startMemoryServer,
} from './index.ts';

const socketPath = process.env.MEMORY_SOCKET_PATH ?? '/root/.harness/run/memory.sock';

const store: MemoryStore = await pickStore();
const audit: AuditLog = await pickAudit();
const snapshots: SnapshotStore = await pickSnapshots();
const idle: IdleThrottleOptions = pickIdleConfig();

console.log(`Starting @ecruz165/edge-memory-server on ${socketPath}…`);
console.log(`  store:     ${store.constructor.name}`);
console.log(`  audit:     ${audit.constructor.name}`);
console.log(`  snapshots: ${snapshots.constructor.name}`);
console.log(`  idle:      ${idle.idleTimeoutMs}ms timeout (PRD F9)`);

const handle = await startMemoryServer({ socketPath, store, audit, idle, snapshots });
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

async function pickStore(): Promise<MemoryStore> {
  const dbPath = process.env.MEMORY_DB_PATH;
  if (!dbPath) {
    console.log('  (no MEMORY_DB_PATH set; using in-memory store)');
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

async function pickAudit(): Promise<AuditLog> {
  const auditPath = process.env.MEMORY_AUDIT_DB_PATH;
  if (!auditPath) {
    console.log('  (no MEMORY_AUDIT_DB_PATH set; using in-memory audit log)');
    return new InMemoryAuditLog();
  }
  return SqliteAuditLog.open({ dbPath: auditPath });
}

function pickIdleConfig(): IdleThrottleOptions {
  return {
    idleTimeoutMs: Number(process.env.MEMORY_IDLE_TIMEOUT_MS ?? '600000'),
    checkIntervalMs: Number(process.env.MEMORY_IDLE_CHECK_INTERVAL_MS ?? '30000'),
  };
}

async function pickSnapshots(): Promise<SnapshotStore> {
  const path = process.env.MEMORY_SNAPSHOT_DB_PATH;
  if (!path) {
    console.log('  (no MEMORY_SNAPSHOT_DB_PATH set; using in-memory snapshot store)');
    return new InMemorySnapshotStore();
  }
  return SqliteSnapshotStore.open({ dbPath: path });
}

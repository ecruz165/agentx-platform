# @ecruz165/edge-memory-server

UDS-fronted memory store for agentx workers. Daemon process that holds
the local agent-memory state — scope-aware, GDPR-compliant, vector-
similarity-capable. Co-located with the harness on each developer
workstation / ECS task; persists across process restarts when configured
with the SQLite + sqlite-vec backend.

> Architecture peer to `@ecruz165/edge-context-server` (Neo4j-backed
> graph-RAG). Distinct engines, distinct processes, independent
> lifecycles — never a shared instance.

## What's in the box

```
src/
├── index.ts             # HTTP server + route handlers
├── main.ts              # Production entrypoint (env-driven backend selection)
├── store.ts             # MemoryStore interface + InMemoryMemoryStore (tests/dev)
├── store.test.ts        # Unit tests for InMemoryMemoryStore
├── sqlite-vec-store.ts  # SqliteVecMemoryStore (production default)
├── sqlite-vec-store.test.ts
└── server.test.ts       # HTTP/UDS round-trip tests
```

## Routes (UDS, JSON)

```
GET  /health                      Liveness + backend state + entry count
GET  /metrics                     Prometheus exposition (PRD F13)
POST /v1/memory/put               body: { key, value, scope? }
POST /v1/memory/query             body: MemoryQuery (kind: structured | recent | similarity | graph)
POST /v1/memory/forget            body: MemoryForgetPredicate (at least one of key, scope, olderThan)
POST /v1/memory/export            body: optional MemoryQuery; response: text/plain JSONL of entries
POST /v1/memory/import            body: text/plain JSONL; response: { imported, errors: [{line, error}] }
POST /v1/audit                    body: optional AuditLogQuery; response: { events, count }
```

`export` + `import` are the v1 backup / GDPR / migration surface (PRD F26). Roundtrip is lossy on identity (server reissues `id` + `createdAt` for every imported entry) but lossless on content (key, value, scope preserved). Similarity / graph query kinds are rejected for export — those don't have natural "all matching entries" semantics.

The `kind:'graph'` query type returns `kind:'unsupported'` from the
v1 backends; defined in the type union so the wire shape matches PRD
F4 and a future graph-capable adapter can drop in.

## Scope keys (per PRD F3)

`jobId`, `productId`, `userId`, `sessionId`, `organizationId`, `topic`.
All optional, AND-combined when set. Subset-match: a query with
`{productId:'web'}` matches entries that have `productId === 'web'`
regardless of their other scope tags.

## Backends — memory store

| Backend | When to use | Persistence | Similarity |
|---|---|---|---|
| `InMemoryMemoryStore` | Tests, dev bringup, environments without sqlite-vec binary | None | ❌ |
| `SqliteVecMemoryStore` | Production default per PRD F10 | SQLite WAL file | ✅ via vec0 + KNN |

## Backends — audit log

| Backend | When to use | Persistence |
|---|---|---|
| `InMemoryAuditLog` | Tests, dev bringup | None |
| `SqliteAuditLog` | Production. Separate file from the memory store by default — different retention + GDPR carve-outs (audit log is append-only forensics that survives `forget`). | SQLite WAL file |

`InMemoryMemoryStore` returns `kind:'unsupported'` for similarity
queries. Same observable shape; the CLI surfaces a clear error rather
than silently returning empty.

## Production config (env)

`main.ts` selects backends at startup:

```bash
# Memory store
export MEMORY_DB_PATH=/var/lib/agentx/memory.sqlite      # unset → InMemoryMemoryStore
export MEMORY_VECTOR_DIM=1024                            # default 1024 (qwen3-0.6B)
export MEMORY_EMBEDDER_URL=http://localhost:12434/engines/llama.cpp/v1
export MEMORY_EMBEDDER_MODEL=ai/qwen3-embedding:0.6B-F16

# Audit log (PRD F12) — separate file by default; same file works
# but mixes retention policies.
export MEMORY_AUDIT_DB_PATH=/var/lib/agentx/memory-audit.sqlite   # unset → InMemoryAuditLog

# Listen address
export MEMORY_SOCKET_PATH=/root/.harness/run/memory.sock

# Idle throttling (PRD F9) — daemon transitions warm→idle after this
# many ms of no /v1/* traffic. /health and /metrics scrapes don't count.
# First /v1/* call after idle awaits the onWarm hook, then proceeds.
export MEMORY_IDLE_TIMEOUT_MS=600000               # default 10min
export MEMORY_IDLE_CHECK_INTERVAL_MS=30000         # default 30s
```

The embedder env vars are only required when `MEMORY_DB_PATH` is set
(SqliteVec backend embeds string values on `put` and queries on
`similarity`).

Schema dim is **locked to `MEMORY_VECTOR_DIM` at first open**. Changing
the embedder to a different-dim model requires a fresh DB file.

## Programmatic use (for tests / embedding the server)

```ts
import {
  startMemoryServer,
  InMemoryMemoryStore,
  SqliteVecMemoryStore,
} from '@ecruz165/edge-memory-server';

// Tests / dev
const handle = await startMemoryServer({
  socketPath: '/tmp/mem.sock',
  // store defaults to a fresh InMemoryMemoryStore
});

// Production
const store = await SqliteVecMemoryStore.open({
  dbPath: '/var/lib/agentx/memory.sqlite',
  vectorDim: 1024,
  embed: async (texts) => [...],   // your embedder
});
const handle = await startMemoryServer({
  socketPath: '/var/run/memory.sock',
  store,
});

// later
await handle.stop();
```

## Client surface

Operators + agents talk to this daemon via `@ecruz165/edge-memory-cli`,
which ships as a peer package with a `bin: edge-memory` entry. See
[`packages/edge-memory-cli/README.md`](../edge-memory-cli/README.md).

The PRD's `harness memory ...` invocations are deprecated — the surface
moved to the peer CLI for cold-start budget reasons (~24ms vs ~134ms
per agent invocation).

## Hard rules (per PRD § 4.3 — v1 trust model)

- UDS-only with `0600` permissions. File-system ownership is the auth.
- **MCP is banned.** This server never exposes an MCP transport.
- No application-level auth in v1; deferred to v1.x when identity lands.
- Admin operations (e.g., bulk forget against system-scope entries) are
  gated UDS-only — TCP requests rejected with `403`.

## What's NOT in v1-lite

Tracked in PRD; not yet implemented:

- Snapshot + restore for session writes (F5)
- OpenAPI 3.1 auto-gen from Zod schemas (F11)
- **Consolidation API + feedback tagging** (F14-F19) — the entire
  job-scope → product-scope promotion lifecycle, including LLM-driven
  `feedback-summarize` strategy
- `inspect` CLI subcommand
- `--workspace` flag (F27)

## Tests

```sh
pnpm --filter @ecruz165/edge-memory-server test
```

49 tests cover:
- InMemoryMemoryStore: put, scope filtering (single + AND), recent
  ordering, unsupported similarity/graph, size, forget (key/scope/
  olderThan/AND/empty-predicate-rejected/sample-cap)
- SqliteVecMemoryStore: open + schema (in-memory + file-backed +
  reopen), put/structured/recent, similarity (planted vectors → closest
  first, topK respected, scope-filtered, non-string values absent),
  forget (cleans up vec rows, persists across reopen), error paths
  (dim mismatch, post-close)
- HTTP/UDS: health, put → query round-trip, recent ordering, similarity
  unsupported, forget round-trip + 400 on empty predicate, malformed
  JSON

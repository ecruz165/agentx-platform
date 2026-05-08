# edge-context-server

Per-workspace knowledge-graph server backing GraphRAG queries. Ingests workspace artifacts (code via tree-sitter, files, docs) into Neo4j and exposes a UDS REST surface for query + ingest operations. Companion to `edge-memory-server`; both run as edge sidecars in the worker DevContainer.

**MCP is structurally absent.** This server never exposes MCP and never depends on `@modelcontextprotocol/sdk` (PRD F9, corporate `feedback_no_mcp`).

## Architecture at a glance

```
┌──────────────────┐     ┌────────────────────────┐      ┌────────────────┐
│  edge-context    │     │  edge-context-server   │      │  Neo4j         │
│  CLI (agent +    │ UDS │  Hono-less node:http   │ Bolt │  (sidecar)     │
│  human)          ├────▶│  +  ws WebSocket       ├─────▶│                │
└──────────────────┘     └────────────────────────┘      └────────────────┘
                              ▲                              ▲
                              │ programmatic                 │ direct (bypass)
                              │                              │
                         harness-core                    agentx-load CLI
                         (phase enrichment)              (operator workflows)
```

Single source of truth: Neo4j. Two write paths converge there — server-mediated ingest (observable, cancellable) and `agentx-load` direct (offline, ad-hoc).

## Quick start

```bash
# Sidecar Neo4j + embedder must be running first.
docker compose up -d neo4j-edge embedder

# Start the server.
CONTEXT_SOCKET_PATH=~/.harness/run/context.sock \
  bun packages/edge-context-server/src/main.ts

# In another terminal — ingest + query.
edge-context import-repo --name my-app --path ./src
edge-context events --ingest <ingestId>          # watch progress

edge-context traverse --entity AuthService --depth 2
edge-context search --query "rate limiting" --top-k 5
```

## API surface

All routes are mounted on a Unix domain socket at `~/.harness/run/context.sock` (override via `CONTEXT_SOCKET_PATH`). UDS-only in v1; TCP listener deferred to v1.x.

### Reads

| Method | Path | Operation | Notes |
|---|---|---|---|
| GET | `/health` | Liveness + backend state | `{state: warm \| no-backend \| backend-error}` |
| GET | `/v1/stats` | Graph metrics | Node count, edge count, indexed labels |
| POST | `/v1/context/query` | Hybrid graph + similarity search | Maps to `graphrag.search` |
| POST | `/v1/traverse` | Depth-bounded subgraph from a seed | `graphrag.traverse` |
| POST | `/v1/related` | Single-predicate adjacency | `graphrag.related` |
| POST | `/v1/query` | Admin Cypher passthrough | `graphrag.cypher` — UDS-only, READ access mode |

### Ingestion

| Method | Path | Operation |
|---|---|---|
| POST | `/v1/ingest/repo` | Start a tree-sitter ingest (local path or git URL). Returns 202 + `ingestId`. |
| POST | `/v1/ingest/upload` | Multipart upload (max 50 MB). Returns 202 + `ingestId` + `entry`. |
| POST | `/v1/ingest/crawl` | Fetch a URL, run readability extraction, ingest as a Doc. |
| POST | `/v1/ingest/github-issues` | Pull issues from a GitHub repository (uses `GITHUB_TOKEN` env). |
| POST | `/v1/ingest/jira` | Pull Jira issues by JQL (uses `JIRA_TOKEN`/`JIRA_EMAIL`/`JIRA_BASE_URL` env). |
| POST | `/v1/ingest/confluence` | Pull Confluence space pages (uses `CONFLUENCE_*` env). |
| GET | `/v1/ingest` | List all ingests this process has handled. |
| GET | `/v1/ingest/<ingestId>` | Status + buffered events. |
| DELETE | `/v1/ingest/<ingestId>` | Cancel in-flight ingest. |
| GET | `/v1/uploads` | List stored uploads. |
| DELETE | `/v1/uploads/<docId>` | Remove file + Doc node + embeddings. |
| WS | `/v1/ingest/events` | Live event stream. Send `{"subscribe":"<ingestId>"}` to filter. |

### Plugins (PRD F14–F16)

| Method | Path | Operation |
|---|---|---|
| GET | `/v1/plugins` | List registered plugins |
| ANY | `/v1/plugins/<id>/<sub>` | Dispatched to plugin's route handler |

The reference `OpenApiPlugin` exposes:
- `GET /v1/plugins/openapi/apis` — list aliases
- `POST /v1/plugins/openapi/lookup` — body `{ api, operation }` → operation details
- `POST /v1/plugins/openapi/operations` — body `{ api }` → all operations
- `POST /v1/plugins/openapi/reindex` — re-fetch + re-index all specs

### Operations

| Method | Path | Operation |
|---|---|---|
| GET | `/openapi.json` | Hand-curated OpenAPI 3.1 spec |
| GET | `/metrics` | Prometheus-style text exposition |

### Scheduled cron (PRD F7)

In-process `CronScheduler` exposed on the server handle. Pass jobs at startup via `ContextServerOptions.schedule`, or `handle.cron.add(...)` at runtime. Standard 5-field cron expressions (`min hour dom mon dow`).

```ts
const handle = await startContextServer({
  socketPath: '/tmp/ctx.sock',
  ingest,
  schedule: [
    {
      name: 'nightly-issues',
      expression: '0 2 * * *',
      task: () => ingest.startGithubIssuesIngest({
        name: 'nightly', repo: 'org/repo',
      }),
    },
  ],
});
```

## Trust model (v1)

1. **UDS only.** Mode 0600. File-system ownership *is* the auth.
2. **No application-level auth.** Bearer tokens, API keys, mTLS — all deferred to v1.x.
3. **No multi-tenant identity.** Plugin-level `CredentialBroker` (when wired) is for outbound creds, not caller identity.
4. **Admin gate is structural.** `/v1/query` is admin-only by virtue of UDS-only listening; READ access mode at the Neo4j driver level prevents writes regardless of cypher string.

## Per-product graph isolation (F1)

Each `productId` (declared in `harness-workspace.yml`) gets its own Neo4j database via `CREATE DATABASE IF NOT EXISTS`. Falls back to the default database on Neo4j Community Edition (which lacks multi-database). The schema is shared across all per-product DBs; queries against one product never see another product's nodes.

## Idle throttling (F11)

After 10 minutes without a request, the server closes its Neo4j sessions to release resources. The next request will fail until the operator restarts the server (v1 — auto-rewarm comes in v1.x).

Disable in tests with `idleThrottleMs: 0`.

## Intake paths

The PRD describes four intake modes (§ 4.1.5). v1 implements two; the rest are tracked as follow-ups.

| Intake | Status | Triggered via |
|---|---|---|
| Repo (F21) | ✅ implemented | `edge-context import-repo` / `POST /v1/ingest/repo` |
| File upload (F22) | ✅ implemented | `edge-context upload <file>` / `POST /v1/ingest/upload` |
| URL crawl — all scopes (F26) | ✅ implemented | `edge-context crawl <url> --scope page\|subtree\|site` / `POST /v1/ingest/crawl` |
| External source — GitHub Issues (F24) | ✅ implemented | `edge-context ingest-issues --repo <owner/name>` / `POST /v1/ingest/github-issues` |
| External source — Jira (F24) | ✅ implemented | `edge-context ingest-jira --jql "<jql>"` / `POST /v1/ingest/jira` |
| External source — Confluence (F24) | ✅ implemented | `edge-context ingest-confluence --space <KEY>` / `POST /v1/ingest/confluence` |

## What's NOT in v1

- **CredentialBroker integration.** External sources today use environment variables (`GITHUB_TOKEN`, `JIRA_TOKEN`, `CONFLUENCE_TOKEN`, etc.); the PRD's eventual broker-mediated path is parked because `agent-auth-lib`'s broker is typed to LLM providers, not arbitrary external systems. Extending it is its own slice.
- **No TCP listener.** v1 is UDS-only; v1.x adds TCP behind an ingress.
- **No application-level auth.** Bearer tokens, API keys, mTLS — all deferred to v1.x.
- **Lossy Confluence body extraction.** Storage-format HTML is tag-stripped for embedding; macros, tables, code blocks lose their structure. ADF→Markdown is a follow-up.
- **No body chunking for crawled pages or external-source items.** v1 writes one Doc / Issue / JiraIssue / ConfluencePage node per item with a single embedding. Repos go through loader-core's full chunking pipeline; other intakes don't yet.

## Testing

```bash
# Unit tests (no external deps — uses stub backends)
pnpm --filter @ecruz165/edge-context-server test

# Real-Neo4j integration tests
docker compose up -d neo4j-edge embedder
RUN_NEO4J_INTEGRATION=1 \
  NEO4J_TEST_PASSWORD=devpassword \
  pnpm --filter @ecruz165/edge-context-server test
```

## SKILL files

The server ships two reference SKILL files for agent integration. They live in `skills/` and the workspace template installs them into `~/.claude/skills/` (or the equivalent for non-Claude adapters):

- `skills/graphrag.md` — default agent SKILL covering reads + ingestion. Installed by default.
- `skills/graphrag-admin.md` — opt-in admin SKILL that adds raw Cypher (UDS-only, READ-mode). Not installed by default; workspace operators opt in for power-user agent contexts.

## Related packages

- `@ecruz165/edge-context-cli` — the agent + human CLI (`edge-context` binary)
- `@ecruz165/context-loader-core` — ingest pipeline (tree-sitter + chunkers + embedder + Neo4jBackend)
- `@ecruz165/context-loader-cli` (`agentx-load`) — operator CLI that bypasses the server, writing direct to Neo4j
- `@ecruz165/edge-memory-server` — peer edge server (SQLite-vec, agent memory)

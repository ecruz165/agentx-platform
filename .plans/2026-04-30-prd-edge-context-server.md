# Edge Context Server (KuzuDB-backed GraphRAG, + Skill, + CLI client) — PRD

**Status:** Draft
**Date:** 2026-04-30
**Author:** Edwin Cruz
**Audience:** Engineering, product, architecture reviewers
**Companion documents:**
- `.plans/2026-04-30-agentic-harness-design.md` — library architecture (the `ContextProvider` interface this implements)
- `.plans/2026-04-30-agentic-harness-implementation-plan.md` — milestone plan
- `.plans/2026-04-30-agentic-harness-ecosystem-prd.md` — ecosystem index + cross-cutting concerns
- `.plans/2026-04-30-prd-edge-memory-server.md` — peer subsystem; uses SQLite-vec

---

## 1. Goal

A self-hostable knowledge-graph server that ingests workspace artifacts (codebase, PRDs, Confluence pages, GitHub issues, OpenAPI specs) into a KuzuDB property graph and exposes a Cypher-based query API (REST + WebSocket) for agent interrogation. Hosts other `ContextProvider` plugins beyond GraphRAG (OpenAPI lookup, etc.).

> **MCP is not supported** at this layer — banned by corporate policy (`feedback_no_mcp`). The server does not expose MCP; the package does not link `@modelcontextprotocol/sdk`. Agents reach the server via the same CLI humans use (`harness context graphrag ...`), invoking it through their adapter's Bash-tool capability. A workspace `SKILL.md` (`graphrag.md`) teaches the agent the procedure. See § 4.4.

This is one of three peer servers (edge-memory-server, edge-context-server, harness-server). It owns *external read-mostly knowledge*, deployed at the **edge** — per workspace, alongside the agent, rather than centralized. It does not own internal state (edge-memory-server) or job orchestration (harness-server).

### Future architecture: hub-and-spoke

The Edge Context Server is designed to eventually be **primed by a Central Context Server** — an org-wide knowledge graph (shared cross-team docs, system architecture, common APIs, org standards) that pushes baseline knowledge to each edge on a schedule or on-demand. The edge then layers workspace-local ingestion (this repo's code, this team's PRDs, this project's tickets) on top. Agents always query the edge — central is never on the agent's hot path.

This split keeps queries **fast and offline-capable at the edge** while letting the org maintain a **single source of truth centrally**. v1 of this PRD ships the edge in isolation; the priming protocol and Central Context Server design land in v1.x (see § 9, § 11).

## 2. Personas served

| Persona | Need |
|---|---|
| **Architect** | Visualizing codebase relationships; running ad-hoc Cypher queries. |
| **Worker agent** | Invoking `graphrag.traverse`, `graphrag.search`, `graphrag.related`, `openapi.lookup` as REST operations during phase enrichment. |
| **Coordinator agent** | Pre-flight queries to gauge task complexity. |
| **Owen** (operator) | Managing ingestion pipelines, monitoring graph health. |

## 3. User stories

- *As an architect*, I run `harness context graphrag traverse --entity AuthService --depth 2` and see the related call graph.
- *As an agent in `frontend-techstack-upgrade`*, I invoke `graphrag.related` on a Vue 2 component to find every callsite I'll need to update.
- *As an architect*, I ingest a PRD + codebase together so an agent can answer "which code implements section 3.2 of the PRD?"
- *As Owen*, I schedule re-ingestion nightly via cron in `graphrag.config.yml`.
- *As Owen*, I run `harness context graphrag stats` to see graph size, last ingestion time, source breakdown.
- *As an architect*, I run `harness context graphrag cypher "MATCH (f:Function {name: 'auth'}) RETURN f"` (admin-only) for deep exploration.

## 4. Functional requirements

### 4.1 Edge Context Server (long-running daemon)

#### 4.1.1 Graph database

| ID | Requirement |
|---|---|
| F1 | **Per-product KuzuDB graphs.** Each product declared in `harness-workspace.yml` (workspace-template F11) gets its own Kuzu instance at `.harness/graphrag/<productId>/`. Strong isolation between products: a query against `mobile-app` cannot return nodes from `platform-migration`. The server holds N graphs (one per product); idle products are throttled per F11 (memory dropped after 10min). v1.x adds federated cross-product queries via the Central Context Server priming protocol — see § 1 / § 9. |
| F2 | Ingestion pipelines per intake mode (§ 4.1.5): repo (tree-sitter for TS/JS, Java/Kotlin, Python — F21, F25), file upload (F22), external sources (Jira, Confluence, GitHub Issues — F24), URL crawl (F26). Each ingestion targets exactly one product's graph. |
| F3 | Schema — nodes: `File`, `Function`, `Class`, `Module`, `Issue`, `Doc`, `Concept`, `Endpoint`, `Asset`. Edges: `CALLS`, `IMPORTS`, `DEFINES`, `MENTIONS`, `IMPLEMENTS`, `REFERENCES`, `EXPOSES`. Schema is shared across all per-product graphs (so the agent's mental model is consistent regardless of which product it's querying); each product's graph is an instance of this schema. |
| F4 | Vector embeddings on every node for hybrid graph + similarity queries. Embeddings are per-product (same model, different graph) — no cross-product similarity in v1. |
| F5 | Incremental ingestion — only changed files re-process based on content hash. Per-product. |
| F6 | Per-source ingestion configuration in `graphrag.config.yml` is **product-scoped**: each product declares its own ingestion sources (which repos, which Confluence spaces, which crawl URLs, etc.). |
| F7 | Scheduled re-ingestion via cron expressions, scoped per product. |

#### 4.1.2 Server transport & lifecycle

| ID | Requirement |
|---|---|
| F8 | HTTP/JSON over Unix domain socket; v1 is **UDS-only** on the local Docker network. TCP listener + TLS deferred to v1.x — see § 4.3. |
| F9 | The CLI is the only agent-accessible interface. **MCP is intentionally banned** (per `feedback_no_mcp` corporate policy — see § 1, § 4.4, and the agent-adapter PRD § 11/§ 16). The server must not link `@modelcontextprotocol/sdk` or any MCP transport library. |
| F10 | **Trust model:** UDS local-mode with `0600` permissions; file-system ownership is the auth. No in-process TLS, no application-level auth, no multi-tenant identity in v1 — all deferred to v1.x. See § 4.3. |
| F11 | Idle throttling: drop embedding model + KuzuDB working set after 10min idle. |
| F12 | `/health` endpoint with `{ ok, state, backend, lastIngestedAt, nodeCount, edgeCount }`. |
| F13 | WebSocket event stream of ingestion progress: `/v1/ingest/events`. |

#### 4.1.3 Plugin system for non-GraphRAG context

| ID | Requirement |
|---|---|
| F14 | Other `ContextProvider` plugins can be registered (e.g., built-in OpenAPI spec retriever, Linear ticket lookup); each contributes its own REST endpoints (mounted under `/v1/plugins/<plugin-id>/...`). |
| F15 | Plugin manifest in `graphrag.config.yml` declares which providers are active. |
| F16 | Per-plugin auth via `CredentialBroker` (delegated through harness-server in production; local credentials in dev). |

#### 4.1.4 Query APIs

| ID | Requirement |
|---|---|
| F17 | REST: `POST /v1/query` (Cypher; admin-scoped), `POST /v1/search` (hybrid graph + similarity), `POST /v1/traverse` (entity + depth), `POST /v1/related` (entity + predicate + depth). |
| F18 | REST: `POST /v1/ingest` (start ingestion of declared sources), `GET /v1/stats` (graph metrics). |
| F19 | Named operation set: `graphrag.traverse`, `graphrag.search`, `graphrag.related`, `graphrag.cypher` (admin-scoped), plus operations from registered non-GraphRAG plugins (e.g., `openapi.lookup`, `openapi.operations`). Each operation maps 1:1 to a REST route (§ 7.2) and a CLI subcommand (F21). |
| F20 | OpenAPI 3.1 spec auto-generated. |

#### 4.1.5 Intake modes

The server accepts knowledge from **four** intake paths, each with its own ingestion strategy and storage shape. All four are exposed via the same SKILL+CLI agent-integration pattern (§ 4.3): an agent triggers ingestion through the CLI; the CLI talks to the server over UDS; the server stores + indexes. Humans use the same CLI surface for ad-hoc imports.

| Intake | Storage shape | Embedding strategy | Trigger |
|---|---|---|---|
| Repo (F21) | tree-sitter AST → graph nodes (`File`, `Function`, `Class`, `Module`) | one embedding per node | `harness context graphrag import-repo` |
| File upload (F22) | binary on local FS (F23) + `Doc`/`Asset` node with `localPath` | content-type-specific (text/PDF/image/binary) | `harness context graphrag upload <file>` |
| External source (F24) | `Doc`/`Issue`/`Page` nodes; original at `sourceUrl`/`ticketId` | chunk + embed | `harness context graphrag ingest jira/confluence/github-issues` |
| URL crawl (F26) | `Doc` nodes with `sourceUrl` + content-hash; cached HTML on local FS | chunk + embed (extracted main content) | `harness context graphrag crawl <url>` |

| ID | Requirement |
|---|---|
| F21 | **Repo import (code structure via tree-sitter):** `POST /v1/ingest/repo` accepts `{ name, source: { type: 'local'; path } \| { type: 'git'; cloneUrl; branch } }`. Server clones (remote) or reads (local), invokes tree-sitter for supported languages (TS/JS, Java/Kotlin, Python; more via grammar plugins per F25), maps parsed AST → graph schema (`File`, `Function`, `Class`, `Module` per F3), generates embeddings on every node, writes to Kuzu. Re-import is incremental — content-hash dedup (F5) skips unchanged files. Exposed to agents and humans via `harness context graphrag import-repo`. |
| F22 | **File upload (arbitrary docs, PDFs, images, datasets):** `POST /v1/ingest/upload` (multipart) accepts file + metadata. Server stores the binary on local filesystem (per F23), generates content-type-appropriate embeddings (text → chunk+embed; PDF → text extraction → chunk+embed; image → multimodal embedding or OCR/caption → embed; binary → metadata-only node), creates a `Doc` or `Asset` node in the graph with `localPath` pointing to the stored file, returns `{ docId, embeddingDims, chunkCount }`. Exposed via `harness context graphrag upload <file> [--description "..."]`. |
| F23 | **Local filesystem storage for uploads:** `.harness/context-uploads/<docId>/<original-name>`. Directory mode `0700`; file mode `0600`. The Kuzu node stores `localPath`; the binary stays on disk (Kuzu is not a blob store). Listing via `harness context graphrag uploads list`; deletion via `harness context graphrag uploads delete <docId>` removes both the file and its graph node + embeddings. Lifecycle: uploads persist for the workspace's lifetime by default; `pruneAfter` policy in `graphrag.config.yml` optional. |
| F24 | **External-source ingestion via SKILL+CLI (Jira / Confluence / GitHub Issues):** agents trigger external-source ingestion through the CLI rather than via scheduled cron. Examples: `harness context graphrag ingest jira --jql "project = MOBILE AND updated > -7d"`, `harness context graphrag ingest confluence --space ENG`, `harness context graphrag ingest github-issues --repo org/name --labels bug`. Authentication via `CredentialBroker.getCredential('jira' \| 'confluence' \| 'github')` from auth-lib. Cron-based scheduled ingestion remains supported per F7 for batch refresh, but **agent-triggered is the preferred v1 UX**. The `SKILL.md` ships with reference invocations. |
| F25 | **Tree-sitter for code structure (mandatory v1 dependency):** the server links `tree-sitter` + per-language grammars (`tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-java`, `tree-sitter-kotlin`) for the supported languages. New languages added by registering a tree-sitter grammar in `graphrag.config.yml` (no server code change). Languages without a grammar fall back to "structureless" Markdown-style chunking — better than nothing, but tree-sitter parsing is the v1 default for code repos. |
| F26 | **External URL crawling (tech-stack docs, changelogs, third-party API references):** `POST /v1/ingest/crawl` accepts `{ name, urls[], scope: 'page' \| 'site' \| 'subtree', maxDepth?, refreshInterval?, allowedDomains?, rateLimitPerHost? }`. Server fetches the URL(s), respects `robots.txt`, rate-limits per host (default 1 req/sec; configurable), extracts main content via readability heuristics (Mozilla Readability or similar), chunks + embeds, creates `Doc` nodes with `sourceUrl` + `crawledAt` + content-hash + canonical URL. `scope: 'page'` fetches just the URL; `scope: 'subtree'` crawls only paths matching the URL's prefix; `scope: 'site'` discovers via `sitemap.xml` or recursive crawl with `maxDepth` limit (default 3). Refresh is incremental — content-hash dedup skips unchanged pages; per-page `Last-Modified`/`ETag` headers honored when present. Common use cases: tech-stack docs (`harness context graphrag crawl https://react.dev --scope site --max-depth 3`), changelogs (`harness context graphrag crawl https://github.com/org/repo/releases.atom`), third-party API references (`harness context graphrag crawl https://api.example.com/docs --scope subtree`). Domain allowlist enforced by `graphrag.config.yml`'s `crawl.allowedDomains` (defense in depth — prevents agents from accidentally exfiltrating internal-only URLs). Authenticated crawls (paid docs) use `CredentialBroker.getCredential('crawl:<host>')` when configured. |

### 4.2 Trust model (v1)

**v1 deployment context: DevContainer on the developer's local machine, alongside harness-server and edge-memory-server.** Single-user, loopback-only, no ingress. The four-point posture below is shared across all three peer servers and aligned with the harness-server PRD § 4.3 + the edge-memory-server PRD § 4.3.

| ID | Requirement |
|---|---|
| F27 | **Local mode:** UDS with `0600` permissions. File-system ownership *is* the auth. Agents in the worker container reach this server via a shared UDS volume mount. |
| F28 | **No in-process TLS in v1.** TCP listener + TLS termination deferred to v1.x — handled by ingress in production deployments, never by the server. |
| F29 | **No application-level auth in v1.** Bearer tokens, API keys, OAuth, mtauth all **deferred to v1.x** — see § 9.1. v1 assumes the DevContainer network is trusted. |
| F30 | **No multi-tenant identity in v1.** Plugin-level `CredentialBroker` (F18) is for outbound credentials (e.g., Anthropic embeddings API) — not caller identity. |
| F31 | **Admin operations** (notably `graphrag.cypher` for ad-hoc Cypher) gated to UDS-only — TCP requests rejected with `403 Forbidden`. The "admin token" framing in older drafts is replaced by connection-source gating. |
| F32 | **Audit log actor** records connection source (`uds:<uid>`); upgrades additively to authenticated identity in v1.x. |

### 4.3 Agent integration: SKILL.md + CLI (no MCP)

**MCP is banned at this server, in any form.** Per `feedback_no_mcp`, MCP is actively suppressed — not just absent. The server never exposes MCP; the package never depends on `@modelcontextprotocol/sdk`. Agents do not consume MCP at all.

Agents reach the server via the existing Bash-tool capability of their adapter (claude-code-cli, opencode-cli, copilot-cli), invoking the CLI client. A workspace-scoped `graphrag.md` SKILL file teaches the agent the procedure:

| ID | Requirement |
|---|---|
| F33 | Server ships a reference `graphrag.md` SKILL file documenting the operations as `harness context graphrag ...` CLI invocations. The workspace template installs it into `~/.claude/skills/graphrag.md` (or the workspace's `.skills/`) inside the worker container. |
| F34 | The CLI is the only agent-facing interface. Server REST is internal (CLI talks to it over UDS); agents never call REST directly. **Test parity is automatic** — what humans run, agents run. |
| F35 | The CLI's `--help` output is the canonical reference; SKILL.md links to it rather than duplicating. |
| F36 | The "admin-scoped" Cypher operation (`graphrag.cypher`) is gated by F31 (UDS-only) and is documented in `graphrag.md` only if the SKILL targets a power-user agent context — defaults to a separate `graphrag-admin.md` SKILL the workspace template does *not* install by default. |

Reference SKILL fragment (illustrative):

```markdown
# GraphRAG operations

To traverse from an entity, run via your Bash tool:
  harness context graphrag traverse --entity <name> --depth <n>

To run a hybrid graph + similarity search:
  harness context graphrag search --query "<text>" --k <n>

To find related entities by predicate:
  harness context graphrag related --entity <name> --predicate <PRED> --depth <n>

The CLI talks to edge-context-server over UDS. No keys, no headers, no MCP — just a subprocess call.
```

### 4.4 CLI client (thin)

| ID | Requirement |
|---|---|
| F37 | `harness context graphrag` subcommand group: `traverse`, `search`, `related`, `stats`, `ingest`, `cypher` (UDS-only — see F31). |
| F38 | `harness context openapi` subcommand group when OpenAPI plugin registered: `lookup`, `operations`, `dependencies`. |
| F39 | `harness context plugins list` — shows all registered ContextProviders. |
| F40 | Routes calls to edge-context-server via UDS per `cli-config.yml`. (TCP routing deferred to v1.x — see § 4.2.) |
| F41 | `--json` flag for machine-readable output. |
| F42 | Cold-start <300ms. |

## 5. Non-functional requirements

### 5.1 Latency targets

| Operation | p95 (warm) | p99 (warm) | First call after idle |
|---|---|---|---|
| CLI subcommand cold-start | <300ms | <500ms | n/a |
| `graphrag.traverse` depth=2, ~1M-edge graph | <100ms | <300ms | <2s (cache warm) |
| `graphrag.search` hybrid, k=10 | <500ms | <1500ms | <3s |
| `graphrag.related` predicate, depth=1 | <80ms | <250ms | <2s |
| `graphrag.cypher` simple match, ≤100 results | <150ms | <500ms | <2s |

### 5.2 Ingestion throughput

| ID | Requirement |
|---|---|
| N1 | Ingestion of 100k-LOC TypeScript repo: <5min initial; <30s incremental (10 changed files). |
| N2 | Per-file ingestion <500ms p95 (parse + embed + write). |
| N3 | Concurrent ingestion of multiple sources without blocking queries. |

### 5.3 Resource & scale

| ID | Requirement |
|---|---|
| N4 | Idle RSS <30MB after 10min idle. |
| N5 | Warm RSS <1GB typical, <2GB peak during ingestion. |
| N6 | Server runs on 4-core / 8GB box for repos up to 1M LOC. |
| N7 | Cross-platform: macOS, Linux (x86_64 + arm64), Windows-WSL2. |

## 6. Technical approach

- **Runtime:** TypeScript on Bun with native KuzuDB bindings.
- **Graph DB:** KuzuDB (embedded; columnar; Cypher; vector index extension).
- **Code parsing:** tree-sitter (multi-language; per-language grammar).
- **Doc parsing:** LangChain text-splitter for semantic chunking.
- **Source mappers:** custom per source type, mapping parsed artifacts → graph schema.
- **Embeddings:** Anthropic voyage-3-lite by default; fallback to local `bge-large` via `@xenova/transformers`.
- **HTTP framework:** Hono.
- **Config validation:** Zod.
- **Process supervision:** launchd / systemd / Task Scheduler.

## 7. API surface

### 7.1 CLI client

```bash
# Graph queries
harness context graphrag traverse --entity AuthService --depth 2
harness context graphrag search --query "rate limiting middleware" --k 5
harness context graphrag related --entity UserComponent --predicate MENTIONS --depth 1
harness context graphrag stats

# Repo import (tree-sitter code structure)
harness context graphrag import-repo my-app --path ./src
harness context graphrag import-repo backend-api --url git@github.com:org/backend-api.git --branch main
harness context graphrag import-repo my-app --incremental                # only re-process changed files

# File upload (PDFs, docs, images, datasets stored on local FS + embedded)
harness context graphrag upload ./design-spec.pdf --description "Mobile checkout v2"
harness context graphrag upload ./schema.json --content-type application/json
harness context graphrag uploads list
harness context graphrag uploads delete <docId>

# External-source ingestion (Jira / Confluence / GitHub Issues — agent-triggered via SKILL+CLI)
harness context graphrag ingest jira --jql "project = MOBILE AND updated > -7d"
harness context graphrag ingest confluence --space ENG
harness context graphrag ingest github-issues --repo org/name --labels bug

# URL crawling (tech-stack docs, changelogs, third-party API references)
harness context graphrag crawl https://react.dev --scope site --max-depth 3
harness context graphrag crawl https://github.com/org/repo/releases.atom --scope page
harness context graphrag crawl https://api.example.com/docs --scope subtree
harness context graphrag crawl <url> --refresh-interval 24h            # schedule incremental refresh

# Scheduled / batch ingestion (config-driven, retained from F7)
harness context graphrag ingest                              # all configured sources from graphrag.config.yml
harness context graphrag ingest --incremental

# Admin (UDS-only — see § 4.2 F31)
harness context graphrag cypher "MATCH (f:Function {name: 'auth'}) RETURN f LIMIT 10"

# Plugins
harness context plugins list
harness context openapi lookup --api stripe --operation create-payment-intent
```

### 7.2 Edge Context Server REST

```http
POST /v1/traverse
{ "entity": "AuthService", "depth": 2 }
→ 200 { "nodes": [...], "edges": [...], "summary": "..." }

POST /v1/search
{ "query": "authentication middleware", "k": 10, "filter": { "type": "Function" } }
→ 200 [{ "node": {...}, "score": 0.91, "snippet": "..." }, ...]

POST /v1/related
{ "entity": "UserComponent", "predicate": "MENTIONS", "depth": 1 }
→ 200 [{ "entity": "...", "path": "...", "relevance": 0.87 }, ...]

POST /v1/ingest
{ "source": { "type": "filesystem", "rootPath": "./src" }, "schema": "typescript", "incremental": true }
→ 202 { "ingestId": "ing_..." }

POST /v1/ingest/repo                                  (per § 4.1.5 F21)
{ "name": "my-app", "source": { "type": "git", "cloneUrl": "git@github.com:org/repo.git", "branch": "main" } }
→ 202 { "ingestId": "ing_...", "repoId": "repo_..." }

POST /v1/ingest/upload                                (per F22; multipart/form-data)
[multipart body: file + { description?, contentType? }]
→ 202 { "docId": "doc_...", "embeddingDims": 1536, "chunkCount": 12, "localPath": ".harness/context-uploads/doc_.../<filename>" }

POST /v1/ingest/crawl                                 (per F26)
{ "name": "react-docs", "urls": ["https://react.dev"], "scope": "site", "maxDepth": 3,
  "refreshInterval": "24h", "rateLimitPerHost": 1 }
→ 202 { "ingestId": "ing_...", "expectedPages": 0 }   # expectedPages populated as discovery progresses

GET /v1/uploads                                       (per F23 — list stored uploads)
→ 200 [{ "docId": "doc_...", "originalName": "...", "uploadedAt": ..., "localPath": "..." }, ...]

DELETE /v1/uploads/{docId}                            (per F23 — removes file + graph node)
→ 204

GET /v1/stats
→ 200 { "nodes": 120483, "edges": 482931, "lastIngestedAt": "...", "sources": [...] }

POST /v1/query                                                        (admin-scoped)
{ "cypher": "MATCH (f:Function)-[:CALLS]->(g:Function {name: 'auth'}) RETURN f" }

GET /health
→ 200 { "ok": true, "state": "warm", "backend": "kuzu", "uptimeMs": ..., "lastIngestedAt": "..." }

WS /v1/ingest/events
< { "type": "ingest-started", "ingestId": "...", "source": "..." }
< { "type": "file-processed", "path": "...", "nodes": 12, "edges": 38 }
< { "type": "ingest-completed", "ingestId": "...", "durationMs": ..., "fileCount": ... }
```

### 7.3 Operation contracts

Each named operation maps 1:1 to a REST route (§ 7.2) and a CLI subcommand (§ 7.1). Input shapes:

- **`graphrag.traverse`** — `{ entity: string, depth: number, predicates?: string[] }` → `POST /v1/traverse`
- **`graphrag.search`** — `{ query: string, k: number, filter?: object }` → `POST /v1/search`
- **`graphrag.related`** — `{ entity: string, predicate: string, depth: number }` → `POST /v1/related`
- **`graphrag.cypher`** — `{ cypher: string }` → `POST /v1/query` (admin-only; rejected with 403 to non-admin tokens)
- Plugin operations registered dynamically — e.g., **`openapi.lookup`** input: `{ api: string, operation: string }` → `POST /v1/plugins/openapi/lookup`

> **MCP is intentionally not supported.** Agents reach this server via REST + WS only. See § 1, § 4.1.2 F9, and the agent-adapter PRD § 11/§ 16 for the corporate-policy rationale.

### 7.4 Workspace config (`graphrag.config.yml`)

Per-product graph isolation (F1) means the config is **product-scoped**: each product declared in `harness-workspace.yml` has its own `graphrag` block here.

```yaml
graphrag:
  databaseRoot: ./.harness/graphrag/      # one Kuzu instance per product under here:
                                          #   ./.harness/graphrag/<productId>/
  port: 7720
  unixSocket: ~/.harness/run/edge-context.sock
  embeddings:
    provider: anthropic
    model: voyage-3-lite

  crawl:
    allowedDomains:                       # defense in depth — crawler refuses URLs outside this list (F26)
      - react.dev
      - api.stripe.com
      - github.com
    defaultRateLimitPerHost: 1            # req/sec
    respectRobotsTxt: true

  uploads:
    rootDir: ./.harness/context-uploads/  # F23 storage location for file uploads
    maxFileSize: 50MB
    pruneAfter: null                      # null = workspace-lifetime; e.g., '30d' for time-based pruning

  # Per-product ingestion configuration. Each product gets its own Kuzu graph
  # at ./.harness/graphrag/<productId>/.
  products:

    - id: mobile-app
      ingestion:
        sources:
          - type: filesystem                  # tree-sitter (F21) — repo workspace-template pre-cloned at .harness/repos/<name>/
            repoName: web-app
            patterns: ["**/*.ts", "**/*.tsx"]
          - type: filesystem
            repoName: mobile-client
            patterns: ["**/*.kt", "**/*.swift"]
          - type: filesystem
            repoName: api-gateway
            patterns: ["**/*.ts"]
          - type: confluence                  # F24
            space: ENG
            credentialRef: confluence
          - type: github-issues               # F24
            repo: my-team/mobile-client
            labels: ["bug", "feature"]
            credentialRef: github
          - type: crawl                       # F26 — tech-stack docs
            urls:
              - https://react.dev
            scope: site
            maxDepth: 3
            refreshInterval: 24h
        schedule: "0 2 * * *"                 # nightly at 2am (per product, F7)

    - id: platform-migration
      ingestion:
        sources:
          - type: filesystem
            repoName: api-gateway
            patterns: ["**/*.ts"]
          - type: filesystem
            repoName: notifications-service
            patterns: ["**/*.ts"]
          - type: filesystem
            repoName: billing-service
            patterns: ["**/*.ts"]
          - type: filesystem
            repoName: identity-service
            patterns: ["**/*.ts"]
          - type: crawl
            urls:
              - https://docs.example.com/platform-v2/changelog
            scope: page                       # just the changelog page; lightweight
            refreshInterval: 6h
        schedule: "0 4 * * *"

# Workspace-wide plugins (cross-product). Per-product plugin overrides allowed inside each product block.
plugins:
  - id: openapi
    config:
      specs:
        - url: https://api.stripe.com/v1/openapi.json
          alias: stripe
        - file: ./openapi/internal.yaml
          alias: internal
```

## 8. Acceptance criteria

- All 36 functional requirements pass automated tests.
- Server starts in <2s with empty database; <5s with 100k-node loaded graph.
- Reference workspace's codebase ingests cleanly with expected node/edge counts (test fixture).
- The reference `graphrag.md` SKILL file resolves correctly from `~/.claude/skills/` inside a worker container; an agent invocation actually runs a graph query via the CLI path documented in F33/F34.
- All § 5.1 latency targets met in CI benchmarks.
- All § 5.2 ingestion targets met.
- Server publishes Docker image + Bun-compiled standalone binary.
- `graphrag.config.yml` validation rejects malformed configs with helpful errors.
- Idle throttling verified.
- **No `@modelcontextprotocol/sdk` in any dependency tree** (CI guard).

## 9. Out of scope (this PRD)

- **Visualization UI** — post-v1 (consumers can pipe `cypher` into existing graph viewers).
- **Cross-workspace federated queries** — post-v1; expected to land via the Central Context Server's priming protocol rather than query-time fan-out (see § 1 future architecture).
- **Central Context Server + priming protocol** — separate PRD in v1.x. v1 of the edge is fully functional standalone; the priming hooks are designed for additive integration without requiring central availability.
- **Real-time streaming ingestion as files change in IDE** — v1.x; v1 is batch with optional watch mode.
- **Custom Cypher editor / playground UI** — post-v1.
- **Built-in graph visualization in TUI / VS Code** — post-v1.

### 9.1 Deferred to v1.x

- **Application-level authentication** (bearer tokens, API keys, mtauth). v1 expects loopback-only DevContainer access; v1.x deployments put the server behind an ingress that handles caller auth.
- **Multi-tenant identity enforcement.** v1 has no identity model; v1.x adds it consistently across all three peer servers.
- **TCP listener + in-process TLS.** v1 is UDS-only; v1.x adds TCP behind an ingress.
- **Admin RBAC for `graphrag.cypher`** beyond UDS-only gating.

### 9.2 Out-of-scope forever (intentional)

- **MCP server interface.** Banned by corporate policy (see § 4.3). The server will never expose MCP; the package will never depend on `@modelcontextprotocol/sdk`. If the policy ever changes, MCP will be added through a separate, opt-in companion package — not by extending this one.

## 10. Dependencies

| Dependency | Why |
|---|---|
| Harness library | Provides `ContextProvider` interface. |
| `tree-sitter` + per-language grammars (`tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-java`, `tree-sitter-kotlin`) | Code-structure extraction (F25); foundation of repo intake (F21). |
| `pdf-parse` (or `pdfjs-dist`) | PDF text extraction for file uploads (F22). |
| `@mozilla/readability` (or equivalent) | Main-content extraction for crawled HTML (F26). |
| `cheerio` | HTML parsing for crawler discovery (sitemap.xml, link extraction). |
| `robots-parser` | `robots.txt` compliance for crawler (F26). |
| `node-fetch` (or built-in `fetch`) | HTTP client for crawler + external-source ingestion (Jira / Confluence / GitHub Issues APIs). |
| `auth-lib` (`CredentialBroker`) | External-source credentials (Jira / Confluence / GitHub) + authenticated crawls (F24, F26). |
| KuzuDB v0.6+ | Graph database. |
| Tree-sitter grammars | Per-language code parsing (`tree-sitter-typescript`, etc.). |
| Embeddings provider | Anthropic voyage or `@xenova/transformers` for local fallback. |
| LangChain text-splitter | Doc chunking. |
| Hono | HTTP framework. |

## 11. Decisions & open questions

### Resolved

| # | Decision |
|---|----------|
| CS-R1 | **Edge-context-server uses Kuzu; edge-memory-server uses SQLite + sqlite-vec. Separate engines, separate files, independent lifecycles — never a shared instance.** Resolves former CS1. Per the edge-memory-server PRD's MS1 decision (2026-05-01). |
| CS-R2 | **Same v1 trust model as harness-server and edge-memory-server: UDS local, no in-process TLS, no app-level auth, no multi-tenant identity. All deferred to v1.x.** Resolves the prior bearer-tokens-from-OS-keychain plan. See § 4.2. |
| CS-R3 | **No MCP server interface in v1 or ever. Agent integration via SKILL.md + CLI per § 4.3.** Aligns with `feedback_no_mcp` corporate policy and the harness-ecosystem-wide ban. |

### Open

| # | Question |
|---|---|
| CS2 | Default embedding provider — Anthropic-hosted (cost) or local (RSS)? |
| CS9 | **Crawler safety defaults (F26).** robots.txt compliance: strict (always honor) or configurable per-source? Default rate limit per host: 1 req/sec, 10 req/sec, or per-host adaptive? **Lean: strict robots.txt by default; 1 req/sec default rate limit; allowlist required for any crawl beyond a single page (operator opt-in to broader scopes).** |
| CS10 | **Crawler discovery scope (F26).** For `scope: 'site'`, prefer `sitemap.xml` exclusively, recursive link-crawl, or both? **Lean: try sitemap.xml first (cheap and authoritative); fall back to recursive with `maxDepth` cap if no sitemap.** |
| CS11 | **Upload size cap (F22).** Default max upload size? Lean: 50 MB per file, configurable. |
| CS12 | **Upload retention (F23).** Default retention for uploaded files — workspace lifetime, time-based pruning, or LRU? Lean: workspace lifetime by default; opt-in `pruneAfter` policy. |
| CS13 | **External-source credential scoping (F24).** Should agent-triggered Jira/Confluence ingestion run as the workspace's shared credentials, or per-user? v1 has no identity, so v1 = shared workspace credentials. v1.x revisits with identity model. |
| CS3 | Cypher query exposure — admin-only by default, or also allow read-only Cypher to non-admin? |
| CS4 | Ingestion concurrency cap — how many sources can ingest simultaneously? |
| CS5 | Schema versioning — what happens when an upgrade changes node/edge types? Migration story? |
| CS6 | OpenAPI plugin: should it be in core context-server or its own plugin package? |
| CS7 | Vector dimensionality — fixed (1536) or configurable per embedding model? |
| CS8 | Central-priming protocol direction — push, pull, or both? Determines whether edge ships v1 with outbound wiring, inbound wiring, or both. |

## 12. Implementation milestones

Aligns with the implementation plan's Layer 4 + ecosystem track:

- **CS-1** — Server skeleton + KuzuDB initialization + `/health` (1 day)
- **CS-2** — Schema definition + Cypher query endpoint (1 day)
- **CS-3** — Tree-sitter ingestion for TypeScript (foundation for F21 / F25); add Java + Python in CS-3a, CS-3b (3 days total)
- **CS-4** — Embeddings integration + similarity search (2 days)
- **CS-5** — `traverse`, `search`, `related` REST endpoints (2 days)
- **CS-6** — Incremental ingestion + content-hash dedup (2 days)
- **CS-7a** — **Repo import (F21):** `POST /v1/ingest/repo` + `harness context graphrag import-repo` CLI; local + git source types; per-language tree-sitter dispatch (1 day)
- **CS-7b** — **External-source ingestion via SKILL+CLI (F24):** Jira / Confluence / GitHub Issues adapters using `CredentialBroker` from auth-lib; agent-triggered + scheduled paths (3 days)
- **CS-7c** — **File upload (F22, F23):** `POST /v1/ingest/upload` (multipart); local-FS storage with `0700`/`0600` perms; per-content-type embedding strategies (text / PDF / image / binary); `uploads list/delete` CLI (2 days)
- **CS-7d** — **URL crawling (F26):** `POST /v1/ingest/crawl` + `harness context graphrag crawl` CLI; `robots.txt` compliance; per-host rate limiting; readability extraction; `scope: page/subtree/site` discovery; `Last-Modified`/`ETag` incremental refresh (3 days)
- **CS-8** — Plugin framework + OpenAPI plugin reference impl (2 days)
- **CS-9** — Idle throttling + warmup + Prometheus metrics (1 day)
- **CS-10** — CLI client (2 days)
- **CS-11** — WebSocket ingestion event stream (1 day)
- **CS-12** — Documentation + ingestion guide (1 day; covers all four intake paths)
- **CS-13** — Reference `graphrag.md` SKILL file documenting all four intake operations (~0.5 day)

Total: **~27 working days** for one engineer. (Up from 19 — four explicit intake paths in § 4.1.5 each got dedicated milestones: repo import F21 = +1d, external-source F24 = +1d over old multi-source CS-7, file upload F22/F23 = +2d, URL crawl F26 = +3d, SKILL.md = +0.5d. MCP-handler milestone removed per § 1 / § 4.1.2 F9; saved ~1d, already absorbed into prior estimates.)

---

*End of Edge Context Server PRD.*

# Edge Memory Server (+ CLI client) — PRD

**Status:** Draft
**Date:** 2026-05-01
**Author:** Edwin Cruz
**Audience:** Engineering, product reviewers
**Companion documents:**
- `.plans/2026-04-30-agentic-harness-design.md` — library architecture (the `MemoryStore` interface this serves)
- `.plans/2026-04-30-agentic-harness-implementation-plan.md` — milestone-level build plan
- `.plans/2026-04-30-agentic-harness-ecosystem-prd.md` — ecosystem index + cross-cutting concerns
- `.plans/2026-04-30-prd-harness-server.md` — peer server (orchestration brain); same v1 trust model
- `.plans/2026-04-30-prd-edge-context-server.md` — peer server (GraphRAG); same v1 trust model

---

## 1. Goal

Provide a long-running daemon that owns the harness's `MemoryStore` state — scope-aware, write-capable, GDPR-compliant, rollback-aware — and a thin CLI client that humans and agents both use to interact with it.

**Agents reach the server through the same CLI humans use, not through MCP.** A workspace `SKILL.md` teaches the agent the procedure; the agent invokes `harness memory ...` via its Bash-tool capability; the CLI talks to the server over UDS. Test parity is automatic.

This is one of three peer servers (edge-memory-server, edge-context-server, harness-server). It owns *internal stateful memory*. It does not own external context (edge-context-server) or job orchestration (harness-server).

## 2. Personas served

| Persona | Need |
|---|---|
| **Daisy** (developer) | Debugging "what does my agent remember?" via CLI. |
| **Owen** (operator) | Auditing memory contents, bulk-deleting on user request. |
| **Worker agent** | Invoking `harness memory query/put/recent/forget` via its Bash tool, guided by `SKILL.md`. |
| **Coordinator agent** | Querying user-scoped memory before routing decisions, same CLI path. |

## 3. User stories

- *As Daisy*, I run `harness memory query --scope user:alice --type recent --limit 20` and see what my agent remembers. The CLI returns in <300ms because the edge-memory-server is already warm.
- *As Daisy*, I run `harness memory forget --scope session:abc-123` to clean up after a debugging session.
- *As Owen*, I run `harness memory export --scope user:alice > backup.jsonl` to archive memory before a deletion request.
- *As Owen*, I run `harness memory inspect` to see scope summaries and storage backend health.
- *As an agent in a phase*, my SKILL.md tells me how to query memory; I run `harness memory query --scope session:$SESSION_ID --type similarity --query "<text>"` via my Bash tool and get a result in <50ms (warm). No MCP involved.
- *As Daisy*, when the edge-memory-server is down, the CLI tells me clearly with a suggested fix (`harness server start memory`).

## 4. Functional requirements

### 4.1 Memory Server (long-running daemon)

| ID | Requirement |
|---|---|
| F1 | Long-running daemon serving HTTP/JSON over Unix domain socket. |
| F2 | Implements harness library's `MemoryStore` interface internally; backend pluggable via config. |
| F3 | **Scope-key dimensions (six in v1):** `jobId`, `productId`, `userId`, `sessionId`, `organizationId`, `topic`. The first two (`jobId`, `productId`) are first-class additions for the workspace's multi-product / per-job model — every job runs against exactly one product (workspace-template F11), and the worker writes/reads job-scope memory by default. In v1 these are *configuration* values supplied by the harness-server worker (not authenticated identity); v1.x adds enforcement when application-level identity lands — see § 4.3. |
| F3a | **Read precedence chain (default).** A query without an explicit scope filter walks this chain narrow→wide and returns the first hit (or unions all hits if `mode: 'union'`): `jobId` → `productId` → `userId` → `organizationId` → `topic`. This gives the agent job-private memory first, falling through to wider accumulated knowledge only when nothing matches at the narrower tier. Explicit `--scope <key>:<id>` overrides the default. |
| F3b | **Write precedence (default).** A write without an explicit scope writes to the narrowest available scope — `jobId` if known, otherwise `sessionId`, otherwise the next available. Writing to a wider scope (`userId`, `orgId`) requires explicit `--scope user:<id>` / `--scope org:<id>` — prevents accidental cross-job pollution. SKILL.md documents this so the agent doesn't have to guess. |
| F4 | Query types: `similarity`, `graph`, `structured`, `recent` per `MemoryQuery` discriminated union. v1 default backend (sqlite-vec) implements `similarity`, `structured`, `recent`; `graph` returns `NotSupportedByBackend` (typed error; CLI surfaces a clear message) until a graph-capable adapter is added in v1.x. |
| F5 | Snapshot + restore for session-scoped writes (rollback participation). |
| F6 | GDPR-compliant `forget` with predicate-based matching. |
| F7 | Concurrent-safe — transactional writes for session-scoped, configurable conflict resolution for cross-scope (last-write-wins or vector-clock merge). |
| F8 | `/health` endpoint returning `{ ok, state: 'warming' \| 'warm' \| 'idle', uptimeMs, backend, version }`. |
| F9 | Idle throttling: after 10min no traffic, drop embeddings model from RAM and close idle DB connections; first-call-after-idle pays warmup cost; subsequent calls warm-fast. |
| F10 | Backends shipped: `InMemoryMemoryStore` (tests/dev only), `SqliteVecMemoryStore` (default, production). Edge-memory-server runs its own SQLite file using `sqlite-vec` — it does **not** share storage with edge-context-server (which uses Kuzu for its code/docs/tickets graph). Other backends (Kuzu, pgvector, Chroma) are out of scope for v1. |
| F11 | OpenAPI 3.1 spec auto-generated from Zod schemas. |
| F12 | Audit log: append-only record of every write + forget operation with `{ timestamp, scope, operation, actor }` where `actor` is the connection source (`uds:<uid>`); v1.x upgrades the field to authenticated identity additively. |
| F13 | Prometheus metrics exported at `/metrics` (request rate, latency histograms, backend state). |

#### 4.1.5 Memory consolidation + feedback gating

A job's job-scope writes are private by default (per F3b) and **`unconfirmed`** at the moment they're written — the agent doesn't yet know whether the attempt was correct. Memory only accumulates in wider scopes (`product`, `user`, `organization`) when entries are explicitly *labeled* with a positive or negative feedback signal. **Unconfirmed entries are pruned at job-end** — the agent's mid-flight working notes don't pollute shared memory.

This makes consolidation a labeling-then-promotion flow, not an "everything bubbles up" flow. Both positive and negative signals matter: "this approach worked" and "this approach failed" are equally valuable for guiding future jobs.

| ID | Requirement |
|---|---|
| F14 | **Consolidation API:** `POST /v1/consolidate` accepts `{ from: { scope: 'job:<id>' }, to: { scope: 'product:<id>' \| 'user:<id>' \| 'org:<id>' }, strategy: ConsolidationStrategy, keepSource?: boolean, feedbackFilter?: ('positive' \| 'negative')[] }`. **Default `feedbackFilter` is `['positive', 'negative']`** — `unconfirmed` entries are *never* consolidated. Setting `feedbackFilter: []` is rejected with a config-error (would consolidate unlabeled noise). Returns `{ promoted: number, skipped: number, summarizedFrom?: number, lineageIds: string[], feedbackBreakdown: { positive: N, negative: N } }`. |
| F15 | **Built-in strategies (all feedback-gated by default):** (a) `feedback-required` (the v1 default) — only entries explicitly tagged `positive` or `negative` are eligible; promotes verbatim with feedback label preserved. (b) `feedback-by-topic` — feedback-required + topic filter (e.g., promote `topic: conventions` only). (c) `feedback-summarize` — LLM-driven: groups entries by feedback label, distills a "what worked / what failed" summary, lands as separate `success-pattern` and `anti-pattern` entries at the wider scope. (d) `include-all` — admin-only lift-and-shift bypassing the feedback gate; logs a warning, requires UDS-only invocation. Custom strategies register as harness library plugins (`PluginRef`). |
| F16 | **Lineage + feedback on entries:** every memory entry carries `provenance: { originatingJobId?, originatingProductId?, consolidatedFrom?: { scope, entryIds[] }, consolidatedBy?: 'rule' \| 'summary' \| 'manual', consolidatedAt?, feedback?: 'positive' \| 'negative' \| 'unconfirmed', feedbackSource?: 'hitl-approval' \| 'hitl-rejection' \| 'phase-success' \| 'phase-failure' \| 'pr-merged' \| 'pr-rejected' \| 'tests-passed' \| 'tests-failed' \| 'rollback' \| 'manual' \| 'agent-self-eval', feedbackAt? }`. Auditable, attributable, prunable. `harness memory inspect --scope product:<id> --show-lineage` surfaces the feedback timeline alongside provenance. |
| F17 | **Lifecycle hooks (feedback-tagging fires continuously, not just at job-end):** harness-server fires events at every feedback moment as they happen — `escalation-approved` / `escalation-rejected` (HITL outcomes), `phase-completed` / `phase-failed`, `session-completed` (`completed` = positive; `errored`/`rejected` = negative), plus JobSink-fed external events (`pr-merged` from GitHubPrSink, `tests-passed` from CI integrations, `rollback` from deployment sinks). `harness-workspace.yml`'s `memory.feedback` block declares which events tag which entries with what scope (e.g., "on `escalation-approved`, tag entries written during the approved phase as `positive`"; "on `pr-merged`, tag all job-scope entries as `positive`"). **Each feedback event incrementally transitions entries from `unconfirmed` to `positive`/`negative` — by job-end, most entries are already tagged.** Consolidation then runs once on `session-completed` over the (now mostly-labeled) job-scope entries. **Pipeline-explicit path also supported:** a coordinator-controlled `consolidate` phase can tag + consolidate manually for finer control (e.g., agent self-evaluates a Phase's output, decides to tag positive/negative independent of any external signal). |
| F18 | **Feedback-tagging API:** `POST /v1/tag` accepts `{ entryIds: string[] \| { scope, predicate }, feedback: 'positive' \| 'negative', feedbackSource: ..., overwrite?: boolean }`. Returns `{ tagged: number, alreadyTagged: number }`. `overwrite: false` (default) skips entries already tagged; `true` re-tags (audited). CLI: `harness memory tag --scope job:<id> --feedback positive --source phase-success` for bulk; `harness memory tag --entry <id> --feedback negative` for individual. |
| F19 | **Residual cleanup of unconfirmed entries at job-end:** because F17's feedback hooks fire continuously, by the time `session-completed` arrives most entries already carry a positive/negative tag. F19 is the *residual* cleanup — entries that never got a feedback signal during the job (no HITL, no test outcome, no PR event covered them) are pruned at job-end. This makes the "writes are working notes; only labeled stuff persists" invariant concrete: an entry exists past job-end *only* if some feedback event labeled it. Operators who want to inspect residual unconfirmed entries before pruning can opt out via `harness-workspace.yml`'s `memory.cleanup.preserveUnconfirmed: true` (with a configurable TTL afterwards — e.g., "keep unconfirmed for 24h post-job for triage, then prune"). |

### 4.2 CLI client (thin)

| ID | Requirement |
|---|---|
| F20 | Subcommands under `harness memory`: `query`, `put`, `recent`, `forget`, `inspect`, `import`, `export`. |
| F21 | All subcommands accept `--scope` with any of the six scope keys: `--scope job:<id>` / `--scope product:<id>` / `--scope user:<id>` / `--scope session:<id>` / `--scope org:<id>` / `--scope topic:<name>` (configuration values, not authenticated identity). Multiple `--scope` flags combine as AND filters. Without `--scope`, the CLI uses the read/write precedence chains from F3a/F3b — so `harness memory query --type recent` from inside a worker container reads the current job's scope by default. |
| F22 | `--json` flag for machine-readable output; default human-readable. |
| F23 | Routes calls to edge-memory-server via UDS per `~/.harness/cli-config.yml`. |
| F24 | Helpful errors when server is unreachable (suggests `harness server start memory`). |
| F25 | Cold-start <300ms (no DB open, no embedding-model load — thin client only). |
| F26 | Bulk import/export: JSONL format, one entry per line. |
| F27 | `--workspace <name>` flag to target a non-default workspace (multi-workspace setups). |

### 4.3 Trust model (v1)

**v1 deployment context: DevContainer on the developer's local machine, alongside harness-server and edge-context-server.** Single-user, loopback-only, no ingress. The four-point posture is shared across all three peer servers and aligned with the harness-server PRD § 4.3.

| ID | Requirement |
|---|---|
| F28 | **Local mode:** Unix domain socket with `0600` permissions. File-system ownership *is* the auth. Agents in the worker container reach this server via a shared UDS volume mount. |
| F29 | **No in-process TLS in v1.** Plain HTTP/1.1 over the local Docker network. TLS termination, if needed, is the ingress's job in v1.x production deployments — never the server's. |
| F30 | **No application-level auth in v1.** Bearer tokens, API keys, OAuth, mtauth all **deferred to v1.x** — see § 9.1. v1 assumes the DevContainer network is trusted (single-user, loopback only). |
| F31 | **No multi-tenant identity in v1.** All six scope keys (`jobId`, `productId`, `userId`, `sessionId`, `organizationId`, `topic` per F3) are configuration values populated by callers, not authenticated identity. The worker container's environment supplies them at spawn time. v1.x adds enforcement when the harness-server adds identity. |
| F32 | **Admin operations** (`forget --all`, bulk `import`, etc.) gated to UDS-only — TCP requests rejected with `403 Forbidden`. |
| F33 | **Audit log actor** field records connection source (`uds:<uid>` for local). The schema upgrades additively to authenticated identity in v1.x without breaking old log entries. |

### 4.4 Agent integration: SKILL.md + CLI (no MCP)

**MCP is not supported at this server, in any form.** Per `feedback_no_mcp` corporate policy, MCP is actively banned — not just absent. The server does not expose one; the package never links `@modelcontextprotocol/sdk` or any MCP transport library. Agents do not consume MCP.

Agents reach the server via the existing Bash-tool capability of their adapter (claude-code-cli, opencode-cli, copilot-cli), invoking the CLI client. A workspace-scoped `SKILL.md` teaches the agent the procedure:

| ID | Requirement |
|---|---|
| F34 | Server ships a reference `memory.md` SKILL file (~50 lines) describing the four memory operations as `harness memory ...` CLI invocations. The workspace template installs it into `~/.claude/skills/memory.md` (or the workspace's `.skills/`) inside the worker container. |
| F35 | The CLI is the only agent-facing interface. Server REST is internal (CLI talks to it over UDS); agents never call REST directly. This means the same CLI humans run is what agents run — **test parity is automatic**. |
| F36 | SKILL.md updates ship as part of the server package (`memory.md`) and are versioned alongside the CLI. When the CLI gains a flag (e.g., v1.x adds `--user` for authenticated identity), SKILL.md updates; agent procedure stays unchanged. |
| F37 | The CLI's `--help` output is the canonical reference; SKILL.md links to it rather than duplicating. |

Reference SKILL.md fragment (illustrative):

```markdown
# Memory operations

The harness-server worker exports `JOB_ID`, `PRODUCT_ID`, `SESSION_ID`, `USER_ID`, `ORG_ID`
into your shell environment. Use these in `--scope` filters.

Default scope behavior:
  - Reads without explicit --scope walk the precedence chain (job → product → user → org → topic).
  - Writes without explicit --scope land in the narrowest available scope (job → session → ...).
  - Always be explicit when writing to a wider scope — wider writes are visible across jobs.

To query memory job-private (the most common case):
  harness memory query --type similarity --query "<text>" --k <n>
  # Implicit --scope job:$JOB_ID via F3a precedence

To recall something from anywhere on this product (e.g., a prior job's notes):
  harness memory query --scope product:$PRODUCT_ID --type recent --limit 20

To recall user-wide preferences (e.g., "user prefers verbose explanations"):
  harness memory query --scope user:$USER_ID --type structured --topic preferences

To write a job-private note (default):
  harness memory put --topic notes --key plan --content "<text>"
  # Writes to job:$JOB_ID

To write something a future job on the same product should see:
  harness memory put --scope product:$PRODUCT_ID --topic conventions --key tabs --content "use 2 spaces"

To write a user-wide preference (rare; cross-product, cross-job):
  harness memory put --scope user:$USER_ID --topic preferences --key verbosity --content "high"

The CLI talks to edge-memory-server over UDS. No keys, no headers, no MCP — just a subprocess call.
```

## 5. Non-functional requirements

### 5.1 Latency targets (acceptance gates for releases)

| Operation | p95 (warm) | p99 (warm) | First call after idle |
|---|---|---|---|
| CLI subcommand cold-start (any) | <300ms | <500ms | n/a |
| CLI warm tool call (server hot, UDS) | <80ms | <200ms | n/a |
| `memory.query` similarity, k=10, 100k entries | <50ms | <150ms | <800ms (model warmup, if computing locally; see § 11 MS5) |
| `memory.put` single entry | <20ms | <80ms | <500ms |
| `memory.recent` limit=50 | <15ms | <50ms | <200ms |
| `memory.forget` predicate, ≤1k matches | <100ms | <300ms | <300ms |

### 5.2 Resource & throughput

These are sized for the v1 single-user DevContainer context. Production aspirational targets (multi-tenant, per-user concurrency caps, etc.) defer to v1.x.

| ID | Requirement |
|---|---|
| N1 | Idle RSS <30MB after 10min idle. |
| N2 | Warm RSS <500MB typical; configurable cap (default 1GB). |
| N3 | 100k entries fits in <500MB warm; >1M entries (production aspirational, v1.x) does not exceed 2GB RSS. |
| N4 | 5–10 concurrent skill invocations without queueing (single-user reality); 100 concurrent (production aspirational, v1.x). |
| N5 | Survives `kill -9` cleanly (transactional writes + checkpoint on every op). |
| N6 | Cross-platform: macOS (darwin), Linux (x86_64 + arm64), Windows via WSL2 in v1; native Windows v1.x. |

## 6. Technical approach

- **Runtime:** TypeScript on Bun (preferred for fast cold-start) or Node 22+ as fallback.
- **HTTP framework:** Hono (fast, edge-compatible).
- **Backends:** plug into `MemoryStore` interface from `@your-org/agentic-harness`. Default: `SqliteVecMemoryStore` — `better-sqlite3` with Alex Garcia's `sqlite-vec` extension loaded at startup via `db.loadExtension()`. Schema: scopes as nullable indexed columns (`user_id`, `session_id`, `org_id`, `topic`); embeddings stored in a `vec0` virtual table; KNN via `MATCH` clause with optional scope filter. A `memory_edges(from_id, to_id, edge_type)` table is provisioned but unused in v1 — preserves migration path to a graph-capable backend in v1.x without schema rewrite.
- **No MCP integration.** Package never depends on `@modelcontextprotocol/sdk`. Agent integration is via SKILL.md + CLI per § 4.4.
- **No in-process TLS or app-level auth in v1** — see § 4.3. UDS file-permission for local; remote handled by ingress in v1.x deployments.
- **Telemetry:** Pino structured logs; OpenTelemetry traces with GenAI semantic conventions; Prometheus metrics.
- **Process supervision:** v1 runs as a process inside its DevContainer (Docker manages lifecycle). v1.x deployments may use launchd / systemd / Task Scheduler when running outside containers.
- **Distribution:** Bun-compiled standalone binary + Docker image + npm package.

## 7. API surface

### 7.1 CLI client (canonical agent + human interface)

```bash
# Query — explicit scope at every dimension
harness memory query --scope job:job_abc123 --type recent --limit 20         # job-private (most common from inside a worker)
harness memory query --scope product:mobile-app --type similarity --query "auth bug" --k 5
harness memory query --scope user:alice --type structured --topic preferences
harness memory query --scope org:acme --type similarity --query "rate-limit conventions" --k 3

# Query — implicit (uses precedence chain F3a; from inside a worker, $JOB_ID is set)
harness memory query --type similarity --query "auth bug" --k 5

# Write — explicit narrow scope (default for a worker)
harness memory put --scope job:job_abc123 --topic notes --key plan --content "..."
harness memory put --scope product:mobile-app --topic conventions --key tabs --content "use 2 spaces"
harness memory put --scope user:alice --topic preferences --key uses-typescript --content "true"

# Write — implicit (uses precedence chain F3b; defaults to job:$JOB_ID)
harness memory put --topic notes --key todo --content "investigate flaky test in checkout flow"

# Forget — explicit scope required (no implicit forget; too dangerous)
harness memory forget --scope job:job_abc123 --all
harness memory forget --scope product:mobile-app --before 2025-01-01

# Tag — label entries with positive/negative feedback (F18; required before consolidation)
harness memory tag --scope job:job_abc123 --topic plan-attempt-1 --feedback positive --source phase-success
harness memory tag --entry mem_xyz --feedback negative --source pr-rejected
harness memory tag --scope job:job_abc123 --predicate '{"topic":"approach"}' \
                    --feedback positive --source hitl-approval

# Consolidate — promote feedback-tagged entries to wider scopes (F14-F17)
# Default strategy `feedback-required` only promotes entries already tagged positive or negative;
# unconfirmed entries are NEVER consolidated.
harness memory consolidate --from job:job_abc123 --to product:mobile-app
                            # uses default strategy (feedback-required); both pos+neg promoted

harness memory consolidate --from job:job_abc123 --to product:mobile-app --feedback-filter positive
                            # promote only validated successes

harness memory consolidate --from job:job_abc123 --to user:alice \
                            --strategy feedback-summarize       # LLM distills "what worked / what failed"
                                                                # → success-pattern + anti-pattern entries

harness memory consolidate --auto                               # apply harness-workspace.yml default policy
                                                                # (runs at session-completed via lifecycle hook F17)

# Inspect — show breakdown per scope
harness memory inspect                          # global summary across all scopes
harness memory inspect --scope job:job_abc123   # per-scope detail
harness memory inspect --scope product:mobile-app --show-lineage   # surfaces consolidatedFrom lineage
harness memory inspect --scope user:alice

# Bulk
harness memory export --scope user:alice > backup.jsonl
harness memory import --scope user:alice < backup.jsonl
```

### 7.2 Memory Server REST (CLI ↔ server only — never agent-facing)

```http
POST /v1/query
Content-Type: application/json
{ "scope": { "userId": "alice" },
  "query": { "type": "similarity", "embedding": [...], "k": 5 } }
→ 200 [{ "id": "...", "content": "...", "metadata": {...}, "score": 0.91 }, ...]

POST /v1/put
{ "scope": { "userId": "alice", "topic": "preferences" },
  "key": "uses-typescript", "value": {...} }
→ 200 { "id": "..." }

POST /v1/forget
{ "scope": { "sessionId": "abc-123" }, "predicate": { "all": true } }
→ 200 { "removed": 47 }

POST /v1/snapshot
{ "scope": { "sessionId": "abc-123" } }
→ 200 { "snapshotId": "snap_..." }

POST /v1/restore
{ "snapshotId": "snap_..." }
→ 200 { "restored": true }

GET /health
→ 200 { "ok": true, "state": "warm", "backend": "sqlite-vec", "uptimeMs": 12345, "version": "1.0.0" }

GET /metrics
→ 200 (Prometheus exposition format)
```

REST is reachable only over UDS in v1; TCP listener is not exposed (admin gating per F32). The CLI is the canonical surface; REST is an implementation detail of the CLI ↔ server connection.

## 8. Acceptance criteria

- All 31 functional requirements pass automated tests.
- All § 5.1 latency targets met in CI benchmarks (regressions >10% block PRs).
- The reference `memory.md` SKILL file resolves correctly from `~/.claude/skills/` inside a worker container; an agent invocation actually reads memory via the CLI path documented in F34.
- CLI binary `harness` (with memory subcommands) ships for darwin / linux / Windows-WSL2.
- Documentation includes quickstart + per-subcommand reference + backend-selection guide.
- Conformance: passes the harness library's `MemoryStore` test kit when wired with each shipped backend.
- Idle throttling verified: server settles to <30MB RSS after 10min no traffic; first call after idle <800ms; subsequent calls warm.
- **No `@modelcontextprotocol/sdk` in any dependency tree** (CI guard via `pnpm why` or equivalent).

## 9. Out of scope (this PRD)

- **Memory analytics dashboards** — post-v1.
- **Memory garbage collection / TTL pruning daemon** — manual-only in v1; automated in v1.x.
- **Memory diff / merge tools** — post-v1.
- **Cross-workspace memory federation** — post-v1.
- **Visualizations** — post-v1.

### 9.1 Deferred to v1.x

- **Application-level authentication** (bearer tokens, API keys, mtauth, etc.). v1 expects loopback-only DevContainer access; v1.x deployments put the server behind an ingress that handles caller auth.
- **Multi-tenant identity enforcement.** Scope keys exist as configuration in v1; v1.x makes them authenticated and enforced.
- **Per-user / per-org quotas.** v1 has no identity to scope quotas to.
- **Remote-mode TCP listener with TLS.** v1 is UDS-only; v1.x adds TCP behind an ingress.
- **Graph query backend.** `query.type === 'graph'` returns `NotSupportedByBackend` in v1; v1.x adds a graph-capable adapter.

### 9.2 Out-of-scope forever (intentional)

- **MCP server interface.** Banned by corporate policy (see § 4.4). The server will never expose MCP; the package will never depend on `@modelcontextprotocol/sdk`. If the policy ever changes, MCP will be added through a separate, opt-in companion package — not by extending this one.

## 10. Dependencies

| Dependency | Why |
|---|---|
| Harness library (`@your-org/agentic-harness`) | Provides `MemoryStore` interface + types. |
| `better-sqlite3` | Synchronous SQLite bindings for Node/Bun (extension-loading capable). |
| `sqlite-vec` | Vector similarity extension (vec0 virtual table, KNN via `MATCH`). |
| Hono | HTTP framework. |

**Explicitly NOT dependencies:** `@modelcontextprotocol/sdk` (banned per § 4.4), `keytar` / OS keychain (no remote auth in v1).

## 11. Decisions & open questions

### Resolved

| #   | Decision |
|-----|----------|
| MS1 | **Edge-memory-server uses SQLite + `sqlite-vec`; edge-context-server uses Kuzu. Separate engines, separate files, independent lifecycles — never a shared instance.** Decided 2026-05-01. |
| MS6 | **No MCP server interface in v1 or ever. Agent integration via SKILL.md + CLI.** Decided 2026-05-01. Aligns with `feedback_no_mcp` corporate policy and the harness-ecosystem-wide ban. |
| MS7 | **Same v1 trust model as harness-server and edge-context-server: UDS local, no in-process TLS, no app-level auth, no multi-tenant identity. All deferred to v1.x.** Decided 2026-05-01. |

### Open

| #   | Question |
|-----|----------|
| MS2 | Default conflict-resolution for cross-scope writes — last-write-wins or vector-clock merge? Affects multi-agent semantics. |
| MS3 | UDS vs. named pipes on Windows — which path supports first; both eventually? |
| MS4 | Should `memory.forget` require an audit-trail comment for compliance environments? |
| MS5 | Embedding model default: hosted (Anthropic voyage) or local (`bge-large` via transformers.js)? Local saves API costs but adds RSS. **Lean: caller-provided embeddings (server stores `number[]`, doesn't compute them) — simplest and removes the embedding-model warmup from § 5.1.** |

## 12. Implementation milestones

Aligns with the implementation plan's Layer 2.5 (memory) + early ecosystem track:

- **MS-1** — Server skeleton: HTTP + UDS transport, `/health`, Pino logger, OpenAPI gen (1 day)
- **MS-2** — `InMemoryMemoryStore` backend wired (1 day)
- **MS-3** — `SqliteVecMemoryStore` backend (`better-sqlite3` + `sqlite-vec`, schema + indexes; six-dimensional scope keys per F3 — `jobId`, `productId`, `userId`, `sessionId`, `organizationId`, `topic`) (2 days)
- **MS-3a** — Read/write precedence chain (F3a/F3b) — server resolves implicit scope filters using the workspace's job/product context (~0.5 day)
- **MS-4** — Idle throttling + warmup logic (1 day)
- **MS-5** — Snapshot + restore for rollback participation (1 day)
- **MS-5a** — **Memory consolidation + feedback gating (F14-F19):** `POST /v1/consolidate` with default `feedback-required` strategy; `feedback-by-topic` + `feedback-summarize` + `include-all` (admin-only) strategies; `provenance` (lineage + feedback fields) on every entry; **`POST /v1/tag` feedback-tagging API**; lifecycle hooks wiring harness-server's `escalation-approved` / `escalation-rejected` / `phase-completed` / `phase-failed` / `session-completed` / external `pr-merged` events to auto-tag relevant entries; **job-end cleanup of unconfirmed entries**; `harness memory consolidate` + `harness memory tag` CLI subcommands (3 days, up from 2 — feedback gating + tagging API + lifecycle wiring is meaningfully more than naive consolidation)
- **MS-6** — CLI client with all subcommands (incl. consolidate) (2 days)
- **MS-7** — Reference SKILL.md (`memory.md`) + worker-container integration test that exercises a real agent invocation through the CLI path; teaches scope precedence + consolidation idioms (1 day)
- **MS-8** — UDS admin gating + audit log + connection-source actor field (~0.5 day)
- **MS-9** — Prometheus metrics (~0.5 day)
- **MS-10** — Documentation + reference consumer; covers six-dimensional scope model + consolidation policies (1 day)

Total: **~13.5 working days** for one engineer. (KuzuMemoryStore milestone removed per MS1; MCP-tools milestone removed per MS6; auth milestone reduced per MS7. New: MS-3a precedence chain (+0.5d), MS-5a consolidation (+2d) — covering F3a/F3b/F14-F17.)

---

*End of Edge Memory Server PRD.*

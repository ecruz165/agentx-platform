# Critical Review — Agentic Harness Ecosystem (15-doc planning corpus)

**Status:** Review findings
**Date:** 2026-05-01
**Reviewer:** Claude (Opus 4.7, parallel-agent synthesis across 5 review threads)
**Scope:** All 15 `.plans/2026-04-30-*.md` documents (~460KB total)

**Companion documents reviewed:**

- `.plans/2026-04-30-agentic-harness-design.md` — library architectural design
- `.plans/2026-04-30-agentic-harness-ecosystem-prd.md` — ecosystem index
- `.plans/2026-04-30-agentic-harness-implementation-plan.md` — layered build plan
- `.plans/2026-04-30-prd-edge-memory-server.md`
- `.plans/2026-04-30-prd-edge-context-server.md`
- `.plans/2026-04-30-prd-harness-server.md`
- `.plans/2026-04-30-prd-harness-cli.md`
- `.plans/2026-04-30-prd-vscode-extension.md`
- `.plans/2026-04-30-prd-workspace-template.md`
- `.plans/2026-04-30-prd-workspace-setup-cli.md`
- `.plans/2026-04-30-prd-agent-auth-lib.md`
- `.plans/2026-04-30-prd-agent-adapter-lib.md`
- `.plans/2026-04-30-prd-harness-core.md`
- `.plans/2026-04-30-prd-token-codecs-lib.md`
- `.plans/2026-04-30-prd-agentic-worker-lib.md`

---

## Executive findings

Two recurring patterns drive most of the issues found:

1. **The `design.md` is internally consistent, but per-deliverable PRDs were written against different snapshots of it.** Every cross-doc bug below is a drift artifact — proof that the ecosystem PRD's job is to be a living source-of-truth for shared shapes, and right now it is just an index.
2. **Policy-by-omission keeps appearing where policy-by-construction is needed.** "No MCP" lives in user memory but isn't enforced at adapter spawn. "UDS-only" is named as auth but every caller has the same identity. v1.x deferrals are written as if they're additive when they're actually load-bearing.

Recommendation: do **not** start Layer-1 code until Tier 1 issues land and `ecosystem-prd` is promoted from index to a real cross-cutting concerns spec.

---

## Tier 1 — Architecture-breaking (must resolve before anyone codes)

### A. Worker-execution model contradicts itself across three docs

- `prd-harness-server.md:70` (F9): v1 worker is "**one ephemeral DevContainer per job, No in-process worker pool.**"
- `prd-harness-server.md:204-207` (§6 Workers) and `:201` (queue impl bullet): v1 is in-process `p-queue`; "no cross-process locking is needed."
- `agentic-harness-implementation-plan.md` Layer 7 marks the runtime as "post-v1; separate project," but `ecosystem-prd:27` treats `agentic-worker-lib` as a v1 foundation.

Three docs describe **three different worker models for v1**. HS-4 (3-day milestone for "in-process worker pool + worktree integration") is sized against the wrong one. Server's `GET /v1/admin/workers` (`prd-harness-server.md:286-288`) returns a `workerId/currentJob` schema that reflects the in-process pool — not the per-container model F9 declares. **Decision is owed before HS-1 starts.**

### B. `agentic-worker-lib` is a 47-line stub for a load-bearing component

- `prd-agentic-worker-lib.md` total length: 47 lines. Author **"Gemini CLI"** while every peer doc is "Edwin Cruz" (provenance smell). Date is 2026-05-01 while every peer is 2026-04-30. "Author" field used vs. peers' "Owner" field. Three signals of a different template/round.
- Missing entirely: worktree allocation/lifecycle (3 docs each pass the buck — `prd-harness-core.md:380`, `prd-agent-adapter-lib.md:269`, worker-lib silent), the `workspace.heartbeat` tool implementation referenced at `:36`, signal escalation beyond SIGTERM (SIGKILL, SIGHUP, child-orphan reaping), cleanup-policy executor (`:46` says "based on harness-server policy" — but this lib *is* the executor), heartbeat protocol (transport? interval? timeout → kill?), concurrency model, failure modes.
- `prd-agent-adapter-lib.md:286-294` and worker-lib `:27` both claim subprocess ownership inside tmux. Two-deep nesting or sibling spawn? Unspecified.
- `:42` "Read-Only Mode" via `tmux attach -r` is documented as a security boundary; it isn't — anyone with FS access to the socket can re-attach without `-r`.

### C. Worktree path schema specified four different ways

- Design `§6.6`: `.harness/wt/<jobId>/<subagentId>/<repoName>/`
- `prd-workspace-template.md:87` (F18): `.harness/wt/<jobId>/<repoName>/` — missing `<subagentId>`
- `prd-workspace-template.md:101` (F25): correct schema (matches design)
- `prd-workspace-template.md:220-227`: illustrative tree omits `<subagentId>` — will be copy-pasted by implementers
- `prd-workspace-setup-cli.md:72` (F10) and acceptance `:230`: matches the broken F18 form

Fan-out (`Fork` in design `§6.6`) silently breaks once a second branch fires.

### D. MCP policy is violated in `design.md` and unenforced everywhere downstream

User memory `feedback_no_mcp.md` says corporate policy is "actively suppress MCP at adapter spawn time, never just leave it unmanaged." Yet:

- `design.md:59`: "Not an MCP server. v1 is an MCP *client* via `McpClientProvider`."
- `design.md:1453-1454` (Q18): **Lean: B. Built-in `McpClientProvider` (client only).**
- `design.md:1525`: reference consumer wires `mcpClientProvider({ id: 'mcp:context7', ... })`.
- `design.md:1670`: M8 milestone is "`ContextProvider` framework + `McpClientProvider`."
- `prd-workspace-template.md` and `prd-workspace-setup-cli.md`: MCP suppression **not mentioned**, but workers run `claude-code-cli`, `opencode-cli`, `copilot-cli` — all auto-load MCP unless explicitly disabled.
- `prd-agent-adapter-lib.md:288-292, :502-503`: the only doc that enforces — a single-layer choke point that the workspace can bypass with `.mcp.json` discovery at `cwd`.

This is a corporate-policy compliance issue. Either resolve Q18 to "A. None in v1" and remove every MCP-client surface, or restate the policy.

### E. Authentication identity gap across all three peer servers

Every edge/orchestration server defers app-level auth to v1.x and trusts UDS file-ownership instead. But:

- `prd-edge-memory-server.md` F12/F33: audit-log actor is `uds:<uid>` — every entry from any worker has the same uid. The audit log carries no useful identity.
- `prd-edge-memory-server.md` F31: scope keys are caller-supplied. An agent that re-exports `JOB_ID=other-job` reads/writes another job's memory; nothing validates the binding.
- `prd-edge-context-server.md` F30: outbound credentials only — not caller identity. Any UDS client can crawl/ingest into any product.
- `prd-harness-server.md:393`: defers API-key/mtauth to v1.x.
- `prd-vscode-extension.md:101, :163, :259` (VS-2 milestone): builds against API-key auth that the server explicitly won't ship in v1.

v1 has zero defense against a misbehaving SKILL.md or compromised agent. This is **not** "additive in v1.x" — it requires retrofitting the audit-log shape and the scope-key binding.

---

## Tier 2 — Contract drift (will cause integration failures)

### F. `CredentialBroker` shape disagrees across three PRDs

- `prd-agent-adapter-lib.md:421-424`: `getCredential(provider) → { apiKey, expiresAt? }`
- `prd-agent-auth-lib.md:155, :161-165`: returns extra `source: 'env' | 'oauth' | 'api-key-stored'`
- `prd-harness-core.md:108, :354-356`: `PolicyEnforcingBroker` wraps but doesn't specify shape
- Design D3 (`prd-harness-core.md:381`) claims `AuthClient` "directly satisfies the broker interface" — false; one has `source`, the other doesn't.

Adapters cannot surface `source` for telemetry, and `PolicyEnforcingBroker`'s cache key is unspecified.

### G. Provider-name vocabulary has three competing taxonomies

- `prd-agent-auth-lib.md:206`: `'copilot' | 'anthropic' | 'openai'` (closed Zod enum — blocks the "register custom providers" goal at `:25`)
- `prd-agent-adapter-lib.md:204`: adapter types `'claude-sdk' | 'claude-code-cli' | 'opencode-cli' | 'copilot-sdk' | 'copilot-cli'`
- `prd-harness-core.md:309`: `requiredProviders: ['anthropic', 'github']` — third name for what agent-auth-lib calls `'copilot'`

No mapping table. Any cross-doc rename touches all three. Bedrock/OpenRouter (agent-auth-lib `:436` v2) cannot be registered without rewriting the schema.

### H. HTTP envelope, health, and CLI taxonomy disagree between the two edge servers

- memory `§7.2`: returns bare arrays + `{ id }`. context `§7.2`: named-key objects `{ nodes, edges, summary }`.
- memory `/health`: `{ ok, state, uptimeMs, backend, version }`. context `/health`: `{ ok, state, backend, lastIngestedAt, nodeCount, edgeCount }`. Single ops dashboard cannot share a parser.
- CLI configs in three locations: memory F23 (`~/.harness/cli-config.yml`), context F40 (relative `cli-config.yml`), template `:241` (`~/.<your-org>/cli-config.yml`). WS3 flags as open.
- Capability namespaces are asymmetric: `harness memory <verb>` has no `plugins` sub-namespace despite memory backends being pluggable; `harness context graphrag/openapi/plugins` does. Top-level `harness <surface>` taxonomy isn't documented anywhere.

### I. `harness-cli` is a 21-line stub but two doc-trees depend on it

- `prd-harness-cli.md:1-21` has only a goal paragraph. No FRs, command list, transport contract, or skills schema.
- `prd-harness-server.md:127` (F35 `CliSource`) reads from `harness submit` stdin.
- `prd-vscode-extension.md:100` configures `harness.cliConfigPath`.
- The CLI is also the agentic-skill surface (`:20`) for memory/context queries — implying a contract that is entirely undefined.

### J. CLI/server parity claim is structurally impossible

- `prd-harness-cli.md:17` claims TUI/CLI parity for "submit, steer, rollback, attach."
- `prd-harness-server.md` F1-F40: defines submit + steer (WS + REST). **No `rollback` endpoint anywhere. No `attach` endpoint.**
- `prd-vscode-extension.md` F20 (`:76`) and CLI both reference attach with no server contract.

### K. VS Code asserts API surfaces nobody else ships

- VS F6 (`:48`): "Memory Inspector queries edge-memory-server through harness-server proxy" — proxy endpoint not defined in server PRD; ecosystem note explicitly says harness-server "does not own memory state" (`prd-harness-server.md:29`).
- VS F22-F24: capture viewer renders `file://` URLs from inside DevContainer (`prd-harness-server.md:197`); unreachable from VS Code host.
- VS F31 (`:102`): multi-root with per-root UDS — no bind-mount story.
- VS F28 (`:94`) shows green/yellow/red connection state and F33 (`:109`) auto-detects local server, but the server only supports loopback in v1 with no auth (`prd-harness-server.md:84`); VS Code's "Configure Server" flow (`:103, :157-167`) prompts for URL + API key as if remote auth exists.

---

## Tier 3 — Spec gaps that invalidate sizing/milestones

### L. 30 open questions in `design.md` still block downstream PRDs

Critical-path Qs:

- **Q1, Q2** → agent-auth-lib + every adapter
- **Q13** → both edge-server boundaries
- **Q16, Q18** → agent-adapter tool/MCP contract (see D)
- **Q20, Q21, Q25** → harness-core catalog + harness-server REST shape
- **Q23** → `ConfigStore` and `workspace-setup-cli` (which writes config)
- **Q26, Q27** → `agentic-worker-lib` package boundary + harness-server worker integration
- **Q31** → harness-server's stance as deployment artifact vs. product

The implementation plan's "fully-typed, partially-implemented" Layer 1 cannot freeze a type surface that still has 30 type-shape decisions open.

### M. Coordinator under-specified despite being central

- `design.md:622-649`: no prompt template, no input-schema requirements, no documented rendering of `whenToUse` (line 604) into the prompt.
- No cost ceiling. Coordinator runs on every `pipeline: 'auto'` invocation. `BudgetGate` plugin (Q4) is generic and shared with phases.
- Fallback is partial — `:629-630` defines `onValidationFailure: 'reject' | 'fallback'` only for *schema-validation* failure. No path for coordinator timeout, API outage, or cost-cap-exceeded.
- `RunResult { status: 'rejected' }` at `:1287`: no UX/CLI/event-stream contract for surfacing rejected jobs, retrying, or feeding back into pipeline-catalog improvement.

### N. `savePipeline`/`deletePipeline` concurrency undefined

- `design.md:752-754, :818-819, :1344-1352`: mutation API exists; no locking, no compare-and-swap, no version field on `Pipeline`.
- Multiple writers (CLI + VS Code + harness-server) can race. With `FsConfigStore` (`:1509, :1674`) and concurrent harness-server replicas, two processes can race `savePipeline()` directly.
- "validate → savePipeline → fire ConfigChangeEvent" (`:1348-1350`) is not described as transactional.
- Implementation plan Phase 3 (`:1034`) is multi-instance harness-server — guaranteed write race.

### O. SQLite + Kuzu concurrency hand-waved

- memory: `better-sqlite3` is **synchronous**; multiple Hono request handlers serialize at libuv. WAL mode, `busy_timeout`, checkpoint cadence not specified. Vector-clock merge is still open as MS2 but referenced as v1 in F7.
- context F1: holds N Kuzu instances simultaneously per product. Kuzu has process-level single-writer per database; concurrent ingestion + scheduled re-ingestion + queries collide head-on. N3's "non-blocking" claim is unsupported.
- WT8 (`prd-workspace-template.md:402`) suggests Kuzu shared-instance for memory + context, **directly contradicting** `project_memory_server_backend.md` ("never shared instance"). Delete WT8 — or accept a memory-policy contradiction.

### P. Embedding model identity not persisted

- memory MS5: leans toward caller-supplied embeddings.
- context F4 / `§6:201`: server-side embeddings (`voyage-3-lite` default; `bge-large` fallback).
- **Neither persists the model identifier alongside the vector.** A model swap silently corrupts similarity search. CS7 flags this as open in context but memory doesn't list it at all.

### Q. GDPR-forget claim contradicts append-only audit log

- memory `§1:18` calls server "GDPR-compliant"; F12 audit log is append-only; F6 specifies predicate-based forget over `metadata` JSON.
- PII embedded in `content` text isn't catchable by metadata-predicate forget without full-text scan; not specified.
- A true GDPR forget must redact PII from the audit trail too, or the trail itself becomes a breach. Either drop the "append-only" claim, add a forget-aware audit redaction step, or downgrade the "GDPR-compliant" claim.

### R. `ecosystem-prd` is index-only, despite promising cross-cutting concerns

`ecosystem-prd:8` lists what should be in the doc — auth, observability, transport, performance, lifecycle, error envelopes, tracing across boundaries, RBAC, secrets propagation. **None of it is there** (the file ends at line 46). This omission is the upstream cause of most of D, E, F, G, H above.

Plus:

- `token-codecs-lib` (733 lines, ships harness pre/post-plugins per `prd-token-codecs-lib.md:40, :50, :265-286`) is **not indexed** in `ecosystem-prd` at all.
- `ecosystem-prd:27` references `2026-05-01-prd-agentic-worker-lib.md`; actual filename is `2026-04-30-prd-agentic-worker-lib.md` — broken link.

### S. token-codecs has hidden type-only dependency

- `prd-token-codecs-lib.md:728` claims `@your-org/agent-adapter` dep is "**None.** Type-only references in docs/examples; not imported."
- But `runTypedExchange` (`:230-256, :524-548`) accepts an `AgentAdapter` and reads `agent.capabilities` at `:511-514`. `PreparedRequest.input` (`:395`) is `AgentInput`. The lib also requests adding `supportsJsonMode` to `AdapterCapabilities` in agent-adapter (`:645` O4) — confirming a real coupling.
- Mark as "type-only soft dep on `@your-org/agent-adapter`" — current claim is not enforceable.
- `tool-use` strategy at `:518` requires `AgentInput.tools/toolChoice` injection. CLI adapters explicitly **cannot accept host-injected tools** (`prd-agent-adapter-lib.md:398`). Auto-pick logic at `:511` doesn't have a capability flag distinguishing "supports tool use" from "accepts host-defined tools" — `runTypedExchange` silently fails for two of five adapters.

### T. Implementation plan missing test deliverables

- No security-test tier called out as a layer gate. Security review is just an FTE allocation (`implementation-plan.md:986`) and a Phase 3 line item (`:1036`), not a per-layer gate.
- No layer for **cross-server integration tests** covering harness-server ↔ edge-memory-server ↔ edge-context-server interplay.
- No coordinator-cost test deliverable despite issue M.
- No conformance test kit shipped for `MemoryStore` (memory acceptance criteria line 292 references one but doesn't ship it). Backends will diverge.

---

## Tier 4 — Stale cross-references and provenance smells

- `prd-workspace-setup-cli.md:73` (F11→template F16) — F16 is GraphRAG config, not pipelines.
- `prd-workspace-setup-cli.md:103` (F24→template F30) — F30 is tmux session-create, not spawn-worker.sh.
- `prd-workspace-setup-cli.md:107` (F28→template F21) — F21 is branch naming, not cleanup policy.
- `prd-edge-memory-server.md` F20 lists subcommands `query|put|recent|forget|inspect|import|export` but examples use undeclared `tag`/`consolidate` (lines 218, 226).
- `prd-agentic-worker-lib.md` author "Gemini CLI" + 2026-05-01 date + "Author" vs "Owner" field — three signals it's a different template/round than the rest. Re-author against the same template as peers.
- Image registry org name placeholder (`your-org/...` everywhere — workspace template `:60, :260, :264, :270, :275`; setup-cli `:23, :68`) suggests these PRDs haven't been pressure-tested against a concrete deploy target.
- Memory PRD `audit log row shape` defined (F12/F33); context PRD audit log row shape never defined despite F32. Compliance reviewers will see two schemas.

---

## Risks / under-specification (worth tracking but not blocking)

- **Versioning / SemVer** — `design.md:1648-1657` is the only SemVer policy in the trio; ecosystem-prd has none, implementation-plan mentions "semver lock" only at `:792` for harness-cli release. **No ecosystem-wide compatibility matrix.**
- **Reconnect-replay correctness** — F25 ring buffer is 1000 events (`prd-harness-server.md:110`); long jobs exceed easily. No spec for what `?since=<seq>` returns when the seq has aged out — 410, replay-from-checkpoint, or silently drop?
- **Idempotency window** — HS5 (`prd-harness-server.md:419`) is open; F5 (`:61`) just says "configured window."
- **Crawler safety** (context F26): allowlist enforcement is config-side; no SSRF defense (block private IP ranges, link-local, metadata-service IPs).
- **`graphrag.cypher` admin-gating via UDS-only** is meaningless when UDS is the *only* transport in v1 — every call is admin. Implementer may legitimately ship Cypher exposed to all callers, contradicting doc intent.
- **DevContainer fitness on macOS** — `docker-outside-of-docker` + UDS shared via volume mount has known UID/permission issues on Docker Desktop's gRPC-FUSE filesystem on macOS. Neither workspace doc acknowledges or tests.
- **Permissions / file ownership** undefined for worktrees written by container UID but read by host user during `harness attach`.
- **VS Code webview ↔ extension trust** — F19/F22 (`:74, :84`) handle steering and diff but no spec on CSP, message origin checks, or how capture-rendered HTML is sanitized — capture content is agent-authored.
- **`harness.captureSensitivity`** (VS F29 `:100`) named but undefined; capture redaction is a security control with no schema.
- **Crash recovery under DevContainer-per-job model** — N6 says SQLite WAL recovers in-flight state, but if F9 is correct, in-flight workers are *separate containers* with their own state; a server crash leaves orphan DevContainers, no orphan-reaper spec.

---

## What the planning corpus does well

- Clean discriminated unions for `HarnessEvent`/`HarnessError`/`RunResult`/`FlowNode` with explicit non-breaking-extensibility (`design.md:1654-1656`).
- agent-adapter's exported conformance suite as a public sub-path (`prd-agent-adapter-lib.md:109-121, :440`) — right shape for "swap a field, change runtime."
- Memory feedback-gated consolidation (memory F14-F19) with continuous tagging is a real architectural call, not handwaving — and the SKILL.md fragment (lines 120-152) operationalizes it.
- Read/write scope precedence chains (memory F3a/F3b) — narrow-to-wide with explicit override is the right default.
- Workspace-template's product-as-bundle-of-repos abstraction (`§4.2 F11`, YAML `:294-345`) genuinely matches cross-repo refactor reality.
- Implementation plan's "fully-typed, partially-implemented" Layer 1 discipline is a strong forcing function — even if Tier 3 issue L means it can't fully deliver yet.
- harness-server `§4.3` trust model's audit-log `actor` field designed to upgrade without schema break is unusually forward-thinking.
- harness-server `§5.2` splits "production aspirational" targets from v1 acceptance gates — prevents the common PRD failure of building v1 against v2 numbers.
- `harness doctor --workers` as a spawn-lifecycle smoke test (`prd-workspace-setup-cli.md:108`, F29) catches an entire class of "the spawn primitives drifted" bugs early.
- agent-auth-lib's three-pattern OAuth taxonomy (Device Flow / PKCE+localhost / PKCE+copy-paste, `:296-329`) with clear per-provider rationale, including why Anthropic must be copy-paste, is excellent reference material.
- Glossaries in both `design.md:1684-1727` and `implementation-plan.md:1055-1067` reduce vocabulary drift.

---

## Recommended fix ordering

1. **Resolve A (worker model), B (worker-lib spec), D (MCP policy).** These are architecture-level. Nothing in Layer 1 should freeze until they land.
2. **Promote `ecosystem-prd` from index to actual cross-cutting spec.** Pin: error envelope, auth identity model (E), provider name table (G), worktree path schema (C), tracing propagation across servers, version-compat matrix, MCP enforcement layer. This unblocks ~10 of the listed issues.
3. **Resolve foundational design Qs** (Q1, Q2, Q13, Q18, Q20, Q21, Q26, Q27, Q31) before per-PRD code.
4. **Fill `harness-cli` PRD** (I, J) — load-bearing for two doc-trees and the agentic-skill story.
5. **Fix mechanical contract drifts** (F, H, all stale cross-refs in Tier 4) — mostly a few-hour cleanup pass.
6. **Edge-server integrity work** (O, P, Q) — concurrency model, embedding-model identity persistence, GDPR/audit-log reconciliation.
7. **Add cross-server integration test tier and coordinator-cost test deliverable** to implementation plan (T).

---

## Issue index (for tracking)

| ID | Severity | Area | Summary |
|----|----------|------|---------|
| A | Tier 1 | architecture | Worker-execution model contradicts itself |
| B | Tier 1 | foundation | agentic-worker-lib is a 47-line stub |
| C | Tier 1 | filesystem | Worktree path schema 4 ways |
| D | Tier 1 | policy | MCP policy violated and unenforced |
| E | Tier 1 | security | Auth-identity gap on all three peer servers |
| F | Tier 2 | contracts | CredentialBroker shape drift |
| G | Tier 2 | contracts | Provider naming taxonomies |
| H | Tier 2 | contracts | Edge-server REST/health/CLI disagreement |
| I | Tier 2 | spec | harness-cli is a 21-line stub |
| J | Tier 2 | contracts | CLI/server parity impossible (no rollback/attach API) |
| K | Tier 2 | contracts | VS Code asserts non-existent surfaces |
| L | Tier 3 | scope | 30 open questions block downstream PRDs |
| M | Tier 3 | spec | Coordinator under-specified |
| N | Tier 3 | concurrency | savePipeline concurrency undefined |
| O | Tier 3 | concurrency | SQLite + Kuzu concurrency hand-waved |
| P | Tier 3 | data | Embedding model identity not persisted |
| Q | Tier 3 | compliance | GDPR-forget vs append-only audit log |
| R | Tier 3 | doc-structure | ecosystem-prd is index-only; token-codecs unindexed; broken date link |
| S | Tier 3 | layering | token-codecs hidden type-only dep on agent-adapter |
| T | Tier 3 | testing | Implementation plan missing security/cross-server test tiers |

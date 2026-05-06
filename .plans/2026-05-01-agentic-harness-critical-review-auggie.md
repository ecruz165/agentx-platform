# Agentic Harness Ecosystem — Critical Review

**Status:** Review notes — partially superseded
**Date:** 2026-05-01
**Author:** Auggie (Augment Agent)
**Audience:** Edwin Cruz, engineering reviewers
**Scope:** Critical review of the 15 design + PRD documents dated 2026-04-30 / 2026-05-01

> **Note (2026-05-06):** Doc set has since pivoted from the embedded graph DB to **Neo4j** (client-server). Critiques in this review that hinged on the prior engine's process-level single-writer lock or native ABI surface no longer apply; lexical mentions have been swept to Neo4j for searchability but the surrounding analysis has not been re-litigated.

**Documents reviewed:**
- `.plans/2026-04-30-agentic-harness-design.md`
- `.plans/2026-04-30-agentic-harness-ecosystem-prd.md`
- `.plans/2026-04-30-agentic-harness-implementation-plan.md`
- `.plans/2026-04-30-prd-agent-adapter-lib.md`
- `.plans/2026-04-30-prd-agentic-worker-lib.md`
- `.plans/2026-04-30-prd-agent-auth-lib.md`
- `.plans/2026-04-30-prd-edge-context-server.md`
- `.plans/2026-04-30-prd-edge-memory-server.md`
- `.plans/2026-04-30-prd-harness-cli.md`
- `.plans/2026-04-30-prd-harness-core.md`
- `.plans/2026-04-30-prd-harness-server.md`
- `.plans/2026-04-30-prd-token-codecs-lib.md`
- `.plans/2026-04-30-prd-vscode-extension.md`
- `.plans/2026-04-30-prd-workspace-setup-cli.md`
- `.plans/2026-04-30-prd-workspace-template.md`

---

## TL;DR

The design is internally coherent, well-cross-referenced, and the architectural decisions are mostly defensible. The serious problems are **scope, sequencing, and a handful of load-bearing assumptions that have not been validated**. As written, this is a 6–9 engineer-year program presented as a v1; several "v1" claims will not survive contact with implementation. The document set is ready to *guide* engineering, but it is not yet ready to *commit* engineering against without targeted reductions.

The single most important critique: **none of the 15 documents identifies a first-customer use case concrete enough to validate the architecture**. Every PRD says "first consumer integration" as a checkbox in Phase E/F, but no document names the first job a user will submit, the first pipeline that will run, or the first repo this will be tested against. Without that anchor, every "lean" decision is an unconstrained optimization.

---

## 1. Scope / sizing reality check

Adding the per-PRD estimates (one engineer, focused days):

| Component | Days |
|---|---|
| agent-auth-lib | 4–5 |
| agent-adapter-lib | 9–11 (budget 13) |
| token-codecs-lib | 13–16 (budget 18) |
| harness-core | not aggregated in PRD; design doc M1–M7 spans months |
| edge-memory-server | ~13.5 |
| edge-context-server | ~27 |
| harness-server | not aggregated; HS milestones imply ~25 |
| harness-cli | ~10–15 |
| vscode-extension | ~17 |
| workspace-template | ~15 (+3 helm) |
| workspace-setup-cli | ~13 |
| agentic-worker-lib | not aggregated; tmux+worktree+sandbox is non-trivial |

That's roughly **150–200 focused engineer-days *just for the listed milestones*, and the harness-core/harness-server numbers are missing**. Real calendar will be 1.5–2× that for integration, the inevitable rework when the conformance suite (correctly identified as load-bearing in agent-adapter §5) finds adapter divergence, and the cross-component bugs that don't show up until three peer servers are running together.

**Recommendation:** Either explicitly stage v1 to "agent-auth-lib + agent-adapter (claude-code-cli only) + harness-core + minimal harness-server + workspace-template + workspace-setup-cli + harness-cli" — six components, ~80 days — and defer the rest to v1.x; or commit ≥4 engineers and stop calling this v1.

---

## 2. Critical inconsistencies across documents

These contradict directly and need reconciliation before code starts:

1. **Bun vs Node runtime.** edge-memory-server §6 says "Bun preferred, Node 22+ fallback." edge-context-server §6 says "Bun." token-codecs §5 says "Node ≥20." workspace-template Dockerfiles target `node:22-bookworm` with Bun added. agent-auth-lib and agent-adapter target Node ≥20. **Pick one.** A mixed Bun/Node deployment has real costs: different `better-sqlite3` build flags, different crypto, different ESM resolution edge cases. The peer-server PRDs lean Bun for cold-start; everything else is Node. If the goal is fast cold-start for daemons, Bun-compile only the daemon binaries and keep libs on Node; document this explicitly.

2. **Postgres vs SQLite.** workspace-template §9 helm chart lists "Bitnami Postgres dependency"; the rest of the ecosystem uses SQLite (harness-server checkpointer, edge-memory `sqlite-vec`, edge-context Neo4j) and the harness-server PRD never mentions Postgres. Either remove the Postgres helm dep or explain when/why cluster-mode swaps storage backends — and what that does to the SQLite-based migration paths.

3. **Storage of Neo4j in cluster vs local.** workspace-template open question WT8 ("edge-memory-server and edge-context-server share a Neo4j instance via volume mount") **directly contradicts** edge-memory-server resolved decision MS1 ("Edge-memory-server uses SQLite + sqlite-vec; edge-context-server uses Neo4j. Separate engines, separate files, independent lifecycles — never a shared instance"). MS1 is correct; WT8 is stale and must be deleted.

4. **MCP ban scope.** edge-context-server §1 + §3, agent-adapter §3/§16, edge-memory-server §4.4 all say "MCP banned by corporate policy." But agent-adapter §8.2 says claude-code-cli will be spawned with `--strict-mcp-config --mcp-config /dev/null` — a flag set the PRD admits "verify against the targeted CLI version's flag surface during Phase C — older versions may use a different flag." The whole policy hinges on a CLI flag whose presence in the targeted version has not been verified. **This is a single-point-of-failure for a corporate-policy compliance claim.** It needs a verification gate before any of the three adapter-CLIs is committed to.

5. **Schema-injection capability.** token-codecs §6/§12 depends on `agent.capabilities.supportsJsonMode` to pick its strategy. agent-adapter §7 does not include `supportsJsonMode` in `AdapterCapabilities`. token-codecs O4 admits "file a small follow-up against the agent-adapter PRD when this lib lands" — meaning the libs are spec'd against capabilities that don't exist on the spec'd interface. Add `supportsJsonMode` to agent-adapter §7 now, or remove `json-mode` strategy from token-codecs.

6. **`agent-adapter` vs `harness-core` retry ownership.** agent-adapter §16 says "Retries — Hosts wrap with their own retry; the harness has built-in retry policies." token-codecs §12.4 says "Multi-retry, exponential backoff, and policy-driven retry live in the harness library's `RetryPolicy`." harness-core PRD likely owns this but it is not in the docs I read. Whichever component owns retry must own the rate-limit/backoff state; today three docs gesture at it without claiming it.

---

## 3. Load-bearing assumptions that are not yet validated

### 3.1 SKILL.md + CLI as the agent integration model (replacing MCP)

Repeated across edge-memory, edge-context, and the workspace template: agents reach servers by spawning `harness memory query …` or `harness context graphrag traverse …` via their adapter's Bash tool, guided by a workspace-installed `SKILL.md`. Three concerns:

- **Cold-start cost per call.** edge-memory §5.1 promises `memory.query` p95 <50ms warm (server side). But the agent path is: agent emits Bash tool call → adapter sends to model → model returns → adapter spawns subprocess → CLI binary loads → parses argv → opens UDS → server replies → CLI prints → adapter captures stdout. On macOS, even a Bun-compiled binary's cold-start is 30–80ms; commander+Zod parsing adds 20–50ms; UDS roundtrip + JSON adds 5–15ms. Realistic agent-observed latency is 100–250ms per memory call, *not 50ms*. workspace-setup-cli N4 says `harness server status` p95 <500ms; that's more realistic. Update the latency targets to acknowledge the CLI hop.
- **Token cost of CLI invocations.** Each CLI call is a Bash tool round-trip, costing the model ~50–150 tokens for the tool-use header alone. A phase that hits memory 10 times pays 500–1500 tokens just in tool framing — directly competing with what token-codecs is trying to save on the request side. This is not discussed anywhere.
- **Test parity claim.** edge-memory §4.4 F35: "the same CLI humans run is what agents run — test parity is automatic." This is partially true but elides that agents *call* the CLI through an LLM-mediated path that humans don't. The tests need to cover the model-formatted argv, not just `node cli.js memory query …`.

### 3.2 TOON codec
token-codecs §4 admits TOON's spec status is unverified ("verify spec status during Phase A; vendor a frozen version") and §14 D6 vendors a frozen version. Implementing a serialization format whose spec is in flux, with model-comprehension benchmarks (50×5 hand-authored fixtures) as the only evidence it actually saves tokens *in practice*, is a Phase F dependency on multiple unproven things. The bench harness is a 2.5-day investment that produces the data needed to justify TOON's existence — but the codec is in v1 before the bench has run. **Reorder:** ship `yaml` + `json-min` in v1, run the bench, then add `toon` once it has demonstrably better savings × comprehension on the target models.

### 3.3 Per-product, multi-repo worker DevContainer
workspace-template §1, §4.1, §4.3: each job mounts every repo in the product as a worktree inside the worker. For the example "mobile-app" product (5 repos), every concurrent job creates 5 worktrees; with subagent fan-out (F25–F29), it's 5 × N subagents. For a 100k-LOC codebase × 5 repos × 4 concurrent jobs × 3 subagents each = **60 worktrees on disk simultaneously**, each with its own `.git` index. This is workable on a developer workstation; it is *not* obviously workable at the perf targets stated (worktree allocation <2s, per N3). Validate `git worktree add` time on a real repo of the target size before committing the design. (Suggestion: add a microbenchmark milestone before workspace-template WT-5.)

### 3.4 Memory consolidation feedback-gating (F14–F19, 3 days)
The feedback-tagging lifecycle is conceptually right ("only labeled stuff persists past job-end") but the spec has multiple thorny semantic questions glossed over:
- Who runs `phase-success` vs `phase-failure` evaluation? edge-memory §F17 says harness-server fires the events, but harness-server PRD doesn't mention how it determines success — phases can succeed with caveats, fail-soft, or fail-hard, and the tag they end up with is policy.
- Pruning unconfirmed entries at job-end (F19) is **silent data loss** if the lifecycle hooks fail to fire. The PRD covers `preserveUnconfirmed: true` as opt-out, but the default deletes the agent's working notes the moment a job ends — including the notes a developer might want to inspect during a failure post-mortem. Default should be opt-out (preserve), with `preserveUnconfirmed: false` as opt-in pruning.
- 3 days for "feedback gating + lifecycle wiring + tagging API + consolidation strategies (4) + LLM-driven `feedback-summarize`" is dramatically under-budgeted. `feedback-summarize` alone is its own LLM-call surface that needs prompt design, capture, retry, and cost accounting.

### 3.5 Workspace setup CLI's `harness submit` claim
workspace-setup-cli §3 user story: "harness submit fix-bug --input task.md and watch a fresh worker DevContainer spin up and start streaming events." N6 promises worker spawn lifecycle p95 <15s. `devcontainer up` cold (no image cache) on a worker definition with even modest `features` (Node + Bun + git + tmux + claude-code + opencode + gh + harness-cli + agentic-worker-lib runtime) is **30–90s** the first time. The "warm worker image" caveat saves you, but the PRD never quantifies what fraction of submissions hit warm vs cold cache, and `harness workspace prune --workers` (default 7-day TTL) means moderate-frequency users will repeatedly pay the cold path.

---

## 4. Architecture-level concerns

### 4.1 Three-peer-server topology vs single binary
The split into harness-server / edge-memory-server / edge-context-server is justified as separation of concerns, but each one runs in its own DevContainer (workspace-template F2–F4, F13). The cost: 3 container images to maintain, 3 health endpoints, 3 idle-throttling policies, 3 `harness server start/stop/status` paths, 3 audit-log schemas, 3 release cadences. The benefit (independent scaling, blast-radius isolation) is mostly meaningful at scale — which v1 explicitly is not. **For v1 (single-user DevContainer), one binary serving all three responsibilities behind three URL prefixes would be simpler, faster to start, and easier to debug.** The current topology should be defended on grounds beyond "three concerns" — e.g., "edge-context-server's Neo4j memory profile is fundamentally different and we don't want it in the same process as harness-server's request-serving loop."

### 4.2 `harness-core` vs `harness-server` boundary
harness-core PRD wasn't fully read, but from cross-references it owns LangGraph orchestration, retry policy, plugin registry, and `MemoryStore`/`ContextProvider` interfaces. harness-server then *embeds* harness-core and exposes it over HTTP. This is the right shape — but token-codecs §13.1 shows phases declaring `prePlugins: [{ ref: 'token-codec-rewrite', config: {…, schemaRef: 'AnalysisSchema' } }]` where `schemaRef` resolves "from harness's schema registry." A workspace-managed schema registry is mentioned in passing but isn't a deliverable in any PRD. Decide: either token-codecs accepts inline Zod schemas only (no registry), or harness-core ships a schema registry as a deliverable. Right now it's a hole.

### 4.3 Auth as silent dependency
Trust model in v1 is "DevContainer is single-user, loopback only, UDS file-perm is the auth." Fine for a developer workstation. But:
- `agent-auth-lib` exists, ships OAuth flows, manages `~/.<your-org>/auth.json`, is a hard dep of agent-adapter, and is consumed by every CLI in the ecosystem for *outbound* AI provider credentials.
- That same `auth.json` is sitting in the host home directory while jobs run in containers. Mount strategy isn't specified. agent-adapter §8.2 says claude-code-cli sandboxes `$HOME` and `$TMPDIR` to the worktree to *prevent* state leakage. So how does the CLI inside the worker container reach `~/.<your-org>/auth.json` on the host? Bind-mount? Copy? Re-login per container?
- This is the sort of thing that destroys "5-minute first-run" because the user logs in once on the host and then every worker container fails until the credential propagation is solved. workspace-setup-cli §4.7 says "agent-auth-lib's auth.json is a separate concern; this CLI doesn't manage it." It absolutely needs to manage how it propagates into containers.

### 4.4 Plugin discoverability
harness-core has a plugin registry. token-codecs ships pre-/post-plugins. edge-context-server has `ContextProvider` plugins (F14–F16). agent-adapter has `registerAdapter`. agent-auth-lib has `registerProvider`. Five plugin systems, four registries (token-codecs reuses harness-core's). No single document specifies how a plugin is discovered, loaded, versioned, or constrained for security. For v1 (where plugins are first-party only), this is fine; for the v1.x story where third parties register adapters/codecs/providers, it's missing.

---

## 5. Per-document concerns (significant only)

### `agentic-harness-design.md` (1728 lines)
- Hard to review without a TOC reference and per-section change log. Recommend: split into `architecture.md` + `types.md` + `pipelines.md` rather than one monolith.

### `agentic-harness-implementation-plan.md`
- Phased rollout (M1–M7) is sensible, but each PRD has its *own* phases (Phase A–H or 1–13), and the milestone IDs don't reconcile. e.g., "first-consumer integration depends on M2.7" appears in token-codecs §15 but workspace-template doesn't reference M-numbers at all. Single milestone-id namespace, please.

### `prd-agent-adapter-lib.md`
- Strongest of the foundation PRDs. Conformance suite is genuinely well-thought-out.
- D1 (sessions deferred to v1.1) is the right call but means v1 cannot implement long-running interactive flows; the harness's `Resume` semantics need to be checked against this constraint.
- §8.2 Sandbox: "Spawns with `$HOME` and `$TMPDIR` redirected to the job's `workdir`." This breaks claude-code's `~/.claude/auth.json` lookup unless the workdir contains it. Either mount the host's auth file readonly into the workdir, or document that sandboxed mode requires `ANTHROPIC_API_KEY` env and OAuth doesn't work — these are very different UX promises.

### `prd-agent-auth-lib.md`
- Mostly clean extraction work. The hardcoded Copilot client ID and the `claude-cli/2.1.7` user-agent pinning (§12) are technical-debt timebombs — they will silently break when Anthropic/GitHub rotate. No alerting or version-pinning strategy is described.
- §13 Q1: runtime registration of providers without compile-time generic. Right call for v1, but means `callAI(messages, model, providerName)` typed `providerName: string` rather than a discriminated union. Document that consumers lose type-safety on custom providers.

### `prd-edge-context-server.md`
- §4.1.5 four intake paths (repo, upload, external, crawl) — each is a meaningful product surface. A 1-engineer 27-day estimate covers four crawlers, multipart upload handling, PDF extraction, image embedding, robots.txt, sitemap parsing, rate limiting. **This is two PRDs presented as one.** Split repo-import (CS-7a) + tree-sitter (CS-3) into v1; defer upload (CS-7c), crawl (CS-7d), and external sources (CS-7b) to v1.1. The functional core works for code-search; the doc-knowledge surface can land later.
- F25 mandatory tree-sitter dependency: shipping `tree-sitter-typescript`, `-python`, `-java`, `-kotlin` in a Bun binary is non-trivial — these are native modules with platform-specific builds. macOS arm64 + Linux x86_64 + Linux arm64 + WSL2 = 4 build matrices; verify that Bun's native-module loading is up to it.
- Per-product graph isolation (F1) is a good v1 simplification but defers cross-product queries to "v1.x via Central Context Server priming protocol" — which is a separate PRD that doesn't exist yet. This is a credible roadmap, not a credible v1 story.

### `prd-edge-memory-server.md`
- Six-dimensional scope keys (`jobId, productId, userId, sessionId, organizationId, topic`) is a lot to expose to agents. The SKILL.md fragment in §4.4 is realistic about teaching the model *which scope to use*, but the failure mode where the model writes to the wrong scope (e.g., `--scope user:` instead of `--scope job:`) is silent cross-job pollution. An "expected scope shape" validator should exist; PRD doesn't mention one.
- Consolidation strategies critique: see §3.4 above.

### `prd-harness-cli.md`
- Worth checking: is `harness` one binary that mounts subcommands from each lib (workspace-setup, memory, context, etc.), or is each subcommand its own binary? §29 of workspace-setup-cli says "After init, the user's `harness` CLI binary is installed and the same binary handles all subsequent commands" — that means the harness-cli aggregates everyone else's subcommand mounts. Aggregation strategy (commander mount? plugin discovery?) needs explicit ownership.

### `prd-harness-server.md`
- Job queue + LangGraph orchestration + retry + escalation HITL + capture sink + lifecycle events + worker spawn — five concerns in one server. The PRD is reasonable but the doc is the densest single deliverable.

### `prd-token-codecs-lib.md`
- Strongest single PRD. The decision tree is comprehensive, the trade-offs are explicit, the round-trip-codec rationale (§14 D5) is correct.
- Truncation diagnostics (§11.3) is the most genuinely valuable feature in any of the libs and underplayed.
- Concerns: see §3.2 (TOON), §2 #5 (`supportsJsonMode`).

### `prd-vscode-extension.md`
- 17 days for: activation + sidebar + 4 tree views + command palette + quick-pick flows + active-job webview with React + steering + diff integration + Cursor compat + Marketplace publish. **Optimistic by ~50%.** Webview RAM target <100MB while streaming events at 60fps with React rerender is aspirational; needs throttling/virtualization design that isn't in the PRD.
- Multi-root workspace support (F31) — every command needs to know which root it's targeting. Quick-pick flows should ask, but PRD doesn't say where root-selection lives.

### `prd-workspace-setup-cli.md`
- Over-promises on the cold-cold path (N2 <15min). With 4 image builds (3 server + 1 worker), each carrying tree-sitter native modules + better-sqlite3 + sqlite-vec + Neo4j sidecar pull, on an arm64 Mac with QEMU-emulated x86_64 fallback, 15min is tight. Be honest: 25–40min cold-cold is realistic.
- F8 idempotency claim is correct but `harness init` against a partially-initialized workspace + crash-resume from `init-state.json` (N8) — this is a real piece of engineering that gets one bullet point. Budget 2 days minimum for it; currently bundled into WSC-1+WSC-3 (~2.5 days total for everything).

### `prd-workspace-template.md`
- Strong articulation of the "product = bundle of repos" abstraction.
- Subagent dimension (F25–F29) introduces `<jobId>/<subagentId>/<repoName>` — but harness-core PRD doesn't reference subagents, and the design doc's §6.6 `Fork`/`Send` reference is cited but not quoted. Confirm the design doc actually defines Fork→worktree allocation, otherwise F27 (`WorkspaceManager.allocateSubagent`) is being introduced bottom-up.
- WT8 must be deleted (see §2 #3).

### `prd-agentic-worker-lib.md` and `prd-harness-core.md`
- Key things to confirm on a follow-up read: (a) tmux session naming policy matches workspace-template F30 exactly; (b) sandbox primitives match agent-adapter §8.2 `$HOME`/`$TMPDIR` redirection; (c) harness-core's plugin registry shape matches what token-codecs registers against in §13.1.

---

## 6. Recommendations (prioritized)

1. **Cut v1 scope.** Ship: agent-auth-lib, agent-adapter (claude-code-cli + claude-sdk only — drop opencode-cli, copilot-sdk, copilot-cli to v1.1), harness-core, harness-server, harness-cli, workspace-template, workspace-setup-cli, edge-memory-server. **Defer to v1.1:** edge-context-server (or ship it with repo-import only), token-codecs (run the bench first), vscode-extension. This is still ~80–100 engineer-days and a credible v1.

2. **Reconcile inconsistencies in §2 above before any code commits.** These are all editorial fixes; they compound if left unresolved.

3. **Validate the load-bearing assumptions in §3 with prototypes** — spike claude-code's `--strict-mcp-config` flag against the targeted versions; measure CLI cold-start through an LLM-Bash-tool path; benchmark `git worktree add` at scale; build one TOON encoder and run the comprehension bench. Each spike is 1–3 days; together they de-risk the whole program.

4. **Pick one milestone namespace** (M1–M7 from the implementation plan) and renumber every per-PRD phase to align. Right now, "we'll do this in Phase E" is ambiguous across 10 documents.

5. **Name the first job.** Pick one realistic pipeline + one realistic repo + one realistic developer workflow. Drive every "v1 acceptance" criterion against that one anchor. This is the single highest-leverage addition to the doc set.

6. **Resolve the auth credential propagation story** between host and worker DevContainers before workspace-setup-cli implementation begins. This is a cross-cutting concern that affects every adapter.

7. **Default `preserveUnconfirmed: true`** in edge-memory-server's consolidation policy. Silent data loss is the wrong default.

8. **Add `supportsJsonMode` to agent-adapter `AdapterCapabilities`** now, before token-codecs locks against it.

The architecture is sound. The risks are all execution risks, and they are all addressable with the changes above. The work isn't smaller than the documents suggest — the documents need to be honest that it's larger.

---

*End of critical review.*


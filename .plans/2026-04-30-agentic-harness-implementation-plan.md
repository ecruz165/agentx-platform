# Agentic Harness — Implementation Plan

**Status:** Draft
**Date:** 2026-04-30
**Author:** Edwin Cruz
**Audience:** Implementing engineers, tech leads, code reviewers
**Companion documents:**
- `.plans/2026-04-30-agentic-harness-design.md` — architectural design (the *what* and *why*)
- `.plans/2026-04-30-agentic-harness-ecosystem-prd.md` — product surface PRD (the seven user-facing deliverables)
- This document — implementation plan (the *when* and *how-to-validate*)

---

## 0. Summary

This plan turns the design + PRD into a **layered, testable build sequence**. Three principles drive the structure:

1. **Layered, not horizontal.** Each layer ships a vertical slice — types + impls + tests + demo — that proves a real capability end-to-end before the next layer starts. No "all interfaces, then all implementations" anti-pattern.

2. **Fully-typed, partially-implemented.** Layer 1 defines *every* public type and interface from the design doc — including ones implemented in later layers. Subsequent layers fill in implementations against unchanging interfaces. This makes downstream additions purely additive (no breaking changes between layers).

3. **Test deliverables gate progress.** Each milestone has explicit unit / integration / end-to-end / conformance test deliverables and a runnable demo. A milestone isn't "done" until its acceptance gate is green.

The plan covers **library Layers 0–7** (matching the design doc) plus **PRD ecosystem deliverables** that ship in parallel once the library APIs they depend on stabilize.

Total to v1.0 of the library: ~7 weeks. Ecosystem deliverables (per the PRD) overlap with library work and add ~5 weeks. Total ecosystem v1.0: ~12 weeks for a focused 1–2 person team.

## 1. Goals

- **Predictable progress.** Every milestone has a runnable demo and pass/fail acceptance criteria.
- **No-regret design choices.** Interfaces are designed once in Layer 1 and never broken in later layers.
- **Compounding test coverage.** Tests written for Layer N regression-test Layers 1..N-1.
- **Discoverable failures early.** Layer 0 spike catches architecture-level mistakes before any production code is written.
- **Parallel work where possible.** Library and ecosystem tracks run concurrently after Layer 1.

## 2. Non-goals

- Detailed implementation of every line of code (this is a plan, not a tutorial).
- Locking in tooling choices that should remain consumer-tunable (logger lib, queue lib, etc.).
- Reimplementing the design doc — interfaces and types are referenced, not duplicated.

## 3. The "fully-typed, partially-implemented" discipline

The single most important rule of this plan:

> **Layer 1 ships the complete type surface. Layers 2–7 ship implementations against types that don't change.**

### 3.1 Why

The design has accumulated a rich type surface — discriminated unions for `RunResult`, `HarnessEvent`, `HarnessError`, `FlowNode` (Phase / Fork / Join / Decision), `CoordinatorDecision`, plus interfaces for `Harness`, `MemoryStore`, `ContextProvider`, `SnapshotStrategy`, `ConfigStore`, `JobQueue`, `Workspace`, etc. If even one of these grows or changes shape between layers, every downstream consumer (TUI, VS Code extension, harness-server clients, third-party adapters) has to refactor. The "fully-typed" discipline pays a one-time upfront cost in Layer 1 to avoid recurring breakage.

### 3.2 How

Four forward-compat moves that Layer 1 must adopt:

1. **Discriminated unions, not open enums.** `RunResult.status` is a literal-string union (`'completed' | 'interrupted' | 'rejected' | 'cancelled' | 'errored'`); adding a new variant is non-breaking because exhaustive `switch` statements were already exhaustive.

2. **Optional fields with documented "no-op" semantics.** Layer 1's `Harness` interface includes `events()`, `cancel()`, `estimateCost()`, `savePipeline()` — even though some throw `NotImplementedError` until their layer.

3. **Dependency injection for every subsystem.** `MemoryStore`, `ContextProvider`, `ConfigStore`, `CaptureSink`, `Logger`, etc. are *interfaces* the consumer wires; Layer 1 ships an `InMemoryX` for each so consumers can use them immediately.

4. **Stubs that throw typed errors.** Methods unimplemented in current layer throw `HarnessError { kind: 'config-error', message: 'X is implemented in vN+' }`. Consumers can `catch` and switch on `error.kind` from day 1.

### 3.3 Layer 1 type inventory

Every interface from the design doc lands in `src/types/` in Layer 1. The implementation plan tracks which layer fills in the *body* but not the *signature*.

| Interface | Defined in | Implemented in | Notes |
|---|---|---|---|
| `AgentAdapter`, `AdapterFactory`, `AdapterCapabilities` | L1 | L1 (Claude SDK only); L3 (OpenCode) | Other adapters are post-v1 |
| `AgentSpec` discriminated union | L1 | L1 (Claude+OpenAI specs); L3 (OpenCode spec) | All three present in types from L1 |
| `AgentInvocationResult`, `TokenUsage`, `AgentCapture` | L1 | L1 | Foundation |
| `Phase`, `PhaseConfig` | L1 | L1 | |
| `FlowNode` discriminated union (`Phase` / `Fork` / `Join` / `Decision`), `ParallelMergeStrategy`, `PhasePredicate` | L1 | L1 (`Phase` — every linear flow); L5 (`Fork` + `Join` — parallel composition + subagent worktree allocation); v1 ships `Decision` in the union but doesn't gate on it; `Loop` deferred to v1.x | Replaces former `PhaseNode`. Sub-pipelines expressed as a `Phase` with `agent: { ref: 'sub-pipeline:<id>' }`. See design doc § 6.6. |
| `Pipeline`, `PipelineCatalog` | L1 | L1 | |
| `Profile` | L1 | L1 | |
| `Coordinator`, `CoordinatorDecision`, `AdmissionPolicy` | L1 | L2.6 | L1 ignores `coordinator` field if set |
| `CredentialBroker`, `CredentialStore`, `Credential`, `Provider` | L1 | L1 (Anthropic); L3 (OpenAI, GitHub Copilot) | |
| `Policy<TInput, TDecision>` | L1 | L1 | Foundation for credential/budget/escalation policies |
| `EscalationPolicy`, `EscalationRequest` | L1 | L2.2 | |
| `SteeringMessage`, `SteeringInbox` | L1 | L2.3 | |
| `Harness` interface (full surface) | L1 | L1 (run, resume); L1.6 (cancel); L2.1 (events); L3.5 (savePipeline real impl); L4.4 (estimateCost) | Methods that don't have full impl throw typed `config-error` |
| `RunResult` discriminated union (5 statuses) | L1 | L1 (`completed`/`errored`/`cancelled`); L2 (`interrupted`); L2.6 (`rejected`) | All 5 variants narrowable from L1 |
| `SnapshotStrategy`, `SnapshotRef` | L1 | L1 (memory); L3 (git) | `MemorySnapshot` ships in core |
| `SessionStore`, `CaptureSink` | L1 | L1 (in-memory + filesystem) | Production impls are companion packages |
| `ConfigStore`, `ConfigChangeEvent` | L1 | L1 (in-memory); L3 (FsConfigStore) | |
| `HarnessTool`, `ToolContext`, `ToolResult` | L1 | L1 (registry interface); L2.4 (full registration + dispatch) | |
| `MemoryStore`, `MemoryScope`, `MemoryQuery`, `MemoryEntry` | L1 | L1 (in-memory); L3 (sqlite); ecosystem PRD ships Neo4j | |
| `ContextProvider`, `ContextQuery`, `ContextResult` | L1 | L4.1 | L1 has no concrete impls; provider list defaults to `[]` |
| `Plugin`, `PluginContext`, `PluginResult`, `PluginFactory`, `RuntimeStateProxy` | L1 | L2 (orchestrator runs them); L1 phases simply skip plugins | |
| `HarnessError` discriminated union (13 kinds) | L1 | L1 (a subset is produced); other kinds appear as their layers ship | |
| `HarnessEvent` discriminated union (~17 types) | L1 | L1 (session/phase events); L2.1 (rest) | |
| `RetryPolicy` | L1 | L1 | Foundation |
| `Logger`, `LogFields` | L1 | L1 (console + noop); companion packages add pino/winston | |
| `TracingProvider`, `TracingHandle`, `TracingSessionMetadata` | L1 | L1 (`noopTracingProvider` only); companion packages `tracing-langsmith` + `tracing-otel` ship post-v1 | Orchestrator calls provider at session start / phase boundaries / tool invocations; `noop` default keeps zero-overhead path |
| `CostEstimate`, `PriceTable` | L1 | L4.4 | L1's `estimateCost()` throws `config-error` |
| `Job`, `JobLifecycle`, `JobQueue`, `JobFilter`, `Workspace`, `WorktreeManager`, `JobSource`, `JobSink`, `WorkspaceHooks`, `ConcurrencyConfig` | L1 (in `agentic-harness-runtime` package) | L7 (post-v1) | Types in companion package; impls when runtime layer ships |

**Verification:** After Layer 1 completes, `tsc --noEmit` across `src/` is clean and `tsd` type-tests cover all discriminated-union narrowing.

## 4. Layer 0 — Architecture spike

**Duration:** 3 days
**Goal:** Validate the architectural spine before writing any production code.

### 4.1 What's built

- A throwaway 200–300 line spike that wires:
  - One LangGraph `StateGraph` with two nodes (`plan`, `code`)
  - One Claude API call per node (hardcoded; no `AgentAdapter` abstraction)
  - API key from env (no `CredentialBroker`)
  - Console logging
  - In-memory state (no persistence, no checkpointer)

### 4.2 What we're testing

The validity of these architectural assumptions:

| Assumption | How spike validates it |
|---|---|
| LangGraph TypeScript supports our state-graph shape (typed handoffs + scratch + accumulated usage) | Build a state schema; observe whether reducers compose cleanly |
| Adapter pattern fits as `Runnable` | Try wrapping the Claude call as a `Runnable`; assess ergonomics |
| Credential injection via `RunnableConfig.configurable` is workable | Pass the API key through `configurable`; observe boilerplate in adapter code |
| Three-way coordination (filesystem + graph + memory) is feasible | Sketch the snapshot interface against real LangGraph checkpointer + memfs |
| Token usage flows through `Runnable` results | Verify Anthropic SDK returns usage in a place we can extract |

### 4.3 Acceptance

- The spike runs against a real Anthropic key and produces a coherent two-phase output.
- Architectural decisions in the design doc still feel right after the experience.
- If anything feels wrong, **revise the design doc before starting Layer 1**. Examples that would warrant revision:
  - LangGraph state shape doesn't fit the three-way rollback model
  - `RunnableConfig.configurable` is too implicit for credential injection
  - Tool-use callbacks don't expose enough metadata for the `HarnessTool` registry

### 4.4 Deliverable

- `spike/` directory in the repo (gitignored or committed to a separate branch)
- A 1-page write-up of findings + any design-doc revisions

---

## 5. Layer 1 — Core single-shot run (v0.1)

**Duration:** 2 weeks
**Goal:** Single-shot library that runs one pipeline with one adapter, with full observability scaffolding (logger, errors, retry, cancel) and the complete type surface in place.

### 5.1 Acceptance gate for the layer

Before Layer 2 starts, all of the following must be green:

- ✅ `tsc --noEmit` clean across `src/types/` (full type surface defined)
- ✅ `tsd` / `expect-type` tests cover all discriminated-union narrowing
- ✅ All milestones M1.1–M1.7 acceptance criteria met
- ✅ One real Anthropic-key end-to-end test runs the `feature-add-mini` reference pipeline (plan → code) and produces sensible output
- ✅ Cancellation, retry, error taxonomy, console logging all observable in the demo
- ✅ Code coverage ≥80% on `src/impl/`

### 5.2 Milestones

#### M1.1 — Type foundation (2 days)

**Built:** all interfaces + discriminated unions + Zod schemas in `src/types/`. Every type from § 3.3 has a definition. Methods unimplemented in this layer have signatures + `// LAYER N` comments.

**Tests:**
- **Unit:** Zod schemas parse representative valid configs; reject obvious invalid configs.
- **Type-level (`tsd`):** discriminated-union narrowing is exhaustive (e.g., `switch (result.status)` with all 5 cases passes; missing one fails compile).

**Demo:** `tsc --noEmit` passes; one `examples/types-only.ts` shows the full `Harness` interface usable from a consumer's perspective (with stub methods).

**Acceptance:**
- All design-doc types present in `src/types/`
- All schemas validate fixture configs
- Type tests pass
- No business logic yet

**Depends on:** Layer 0 spike findings

---

#### M1.2 — LangGraph sequence compiler (2 days)

**Built:** `core/graph.ts` builds a LangGraph `StateGraph` from a `Profile.phases` array. v0.1 only honors `kind: 'sequence'` (or bare `PhaseConfig` defaulting to it). Phase orchestrator wraps each phase with snapshot.before / snapshot.after lifecycle hooks (no plugins yet).

**Tests:**
- **Unit:** graph-builder produces expected node count, edges, and reducer functions for sample profiles.
- **Integration:** with a mock `AgentAdapter`, executing a 3-phase profile populates `phaseOutputs` in declared order.

**Demo:** Test that runs a 3-phase mock pipeline; assertion on `ctx.phaseOutputs` matching expected sequence.

**Acceptance:**
- Phases execute in order
- State (phaseOutputs, usage rollup, scratch) propagates correctly through the graph
- Memory snapshot strategy is wired (in-memory deep-clone)

**Depends on:** M1.1

---

#### M1.3 — Claude SDK adapter (3 days)

**Built:** `adapters/claude-sdk.ts` with full normalized verb mapping (model, maxTokens, temperature, topP, topK, stopSequences, seed, reasoningEffort, thinking, systemPrompt, extra). Reports usage. Supports streaming and cancellation.

**Tests:**
- **Unit:** verb mapping table from design doc § 6.3 — input `ClaudeAgentSpec` → expected request shape.
- **Integration (mocked HTTP via `nock`):** adapter produces correct Anthropic API request; consumes response; populates `result.usage` and `result.metadata`.
- **End-to-end (VCR cassette + opt-in real key):** record a real Anthropic call; replay deterministically in CI.

**Demo:** `claudeSdkAdapter.invoke({ prompt: 'hi' })` end-to-end with real key (gated by env var); assert `result.usage.inputTokens > 0`, `result.metadata.model === 'claude-...'`.

**Acceptance:**
- Real Claude calls work on darwin and linux
- `reasoningEffort: 'high'` correctly produces `thinking: { budgetTokens: 32000 }`
- `temperature` rescaled correctly
- `seed` produces a warning (Anthropic doesn't support it natively in v1)
- Streaming yields chunks + a final synthetic `final` chunk with `result`

**Depends on:** M1.1

---

#### M1.4 — Anthropic credential flow (2 days)

**Built:** `auth/broker.ts` (`CredentialBroker` interface + default impl), `providers/anthropic.ts`, env-var-backed `CredentialStore`. `CredentialPolicy` Layer 1 default: explicit per-adapter declaration (matches Q2 lean B).

**Tests:**
- **Unit:** broker resolves valid cred; throws `HarnessError { kind: 'authentication' }` on missing.
- **Integration:** Claude adapter receives credential via `configurable.credentialResolver`; doesn't store the key in adapter state.

**Demo:** Run the M1.3 demo via the credential broker (not hardcoded env access); assert credential never appears in adapter logs.

**Acceptance:**
- Adapter is stateless re: secrets
- Broker rejects resolves outside the adapter's declared `providers: ['anthropic']`

**Depends on:** M1.3

---

#### M1.5 — Logger + error taxonomy + retry (2 days)

**Built:**
- `observability/logger.ts` — `Logger` interface, `consoleLogger({ level })`, `noopLogger`, child-binding semantics.
- `core/errors.ts` — `HarnessError` discriminated union (all 13 kinds), helpers (`isRetriable(error)`, `errorFromAnthropicSDK(...)` factory functions for each kind).
- `core/retry.ts` — `RetryPolicy` interface + execution wrapper that wraps any async fn with policy-driven retry.

**Tests:**
- **Unit:** error classification (each Anthropic SDK error type → expected `HarnessError.kind`); retry backoff math (exponential-jittered correctness over 1000 iterations); logger child-binding produces expected structured fields.
- **Integration:** wrap Claude adapter with retry policy; inject HTTP 503 via mock; observe 3 retries with exponential backoff, then `kind: 'transient'` thrown.

**Demo:** A test where `nock` returns 503 twice then 200; assert the adapter call retries and ultimately succeeds; logged at appropriate levels.

**Acceptance:**
- All Anthropic error responses classify correctly
- Retry respects `maxAttempts`, `backoff`, `retryable` predicate
- `child()` propagates bindings into all sub-logs
- Retry exhaustion produces the right `onMaxAttempts` outcome

**Depends on:** M1.3

---

#### M1.6 — Cancellation API (2 days)

**Built:**
- `harness.cancel(sessionId, opts?)` method
- `RunResult.cancelled` status path through orchestrator
- `AbortSignal` plumbing through `RunnableConfig.configurable.signal` to all adapters
- Snapshot-on-cancel: capture state at point-of-cancel before resolving the cancel promise

**Tests:**
- **Unit:** abort signal propagation order (orchestrator → adapter → underlying SDK).
- **Integration:** start a 5-phase mock pipeline; cancel after phase 2 finishes; assert `result.status === 'cancelled'`, `lastSnapshot.phaseId === 'phase-2'`.
- **End-to-end:** cancel a real Claude streaming call mid-flight; assert it exits cleanly within `timeoutMs`.

**Demo:** Run a long Claude call; press Ctrl+C in a CLI script; observe graceful exit + snapshot.

**Acceptance:**
- In-flight phases respect abort
- Cleanup runs (snapshot, capture flush)
- Adapters without `supportsCancellation` get force-killed after timeout but a warning is logged
- Subsequent `harness.rollback()` to `lastSnapshot.phaseId` works

**Depends on:** M1.2, M1.3

---

#### M1.7 — v0.1 integration demo (2 days)

**Built:**
- `examples/v0.1-feature-add-mini.ts` — a working consumer that runs a 2-phase pipeline (`plan → code`) using Claude SDK
- A small README walkthrough
- v0.1 git tag + CHANGELOG entry

**Tests:**
- **End-to-end:** runs the example to completion against a real key
- **Smoke:** the example's quickstart commands copied verbatim work for a fresh dev

**Demo:** Take a real task ("Generate a function that returns the nth Fibonacci number"); run; observe result.

**Acceptance:**
- Layer 1 ships ✅
- Public API (`Harness` interface) is the v1.0 surface
- Unimplemented methods throw typed `config-error` rather than runtime crashes

**Depends on:** M1.1–M1.6

### 5.3 Test infrastructure stood up in Layer 1 (reused thereafter)

| Tool | Purpose |
|---|---|
| **Vitest** | Test runner for unit + integration |
| **`nock`** | HTTP-level mocking for Anthropic SDK |
| **VCR-style cassettes** (custom or `polly.js`) | Record/replay real API calls deterministically |
| **`tsd`** | Type-level tests for discriminated unions |
| **`@vitest/coverage-v8`** | Coverage reporting |
| **GitHub Actions matrix** | CI on darwin + ubuntu, Node 22 + Bun 1 |

---

## 6. Layer 2 — Observability + HITL (v0.2)

**Duration:** 2 weeks
**Goal:** Events, HITL escalation, steering, memory tools, basic coordinator dispatch.

### 6.1 Acceptance gate

- ✅ All M2.1–M2.7 milestones green
- ✅ HITL pause + resume across process restart works (with persistent checkpointer)
- ✅ Steering at next-boundary works for all adapters; urgent-interrupt works for Claude SDK
- ✅ Coordinator routes correctly for the three reference pipelines
- ✅ Plugin contract documented and exercised by `memory-retrieve` + `memory-write` plugins

### 6.2 Milestones

#### M2.1 — Progress event bus (2 days)

**Built:** in-process pubsub; `harness.events(sessionId)` async-iterable; `harness.onEvent(sessionId|'*', handler)` callback API; emission points in orchestrator, adapter, plugins, escalation, snapshot.

**Tests:**
- **Unit:** event ordering guarantees (per-session FIFO).
- **Integration:** subscribe before `run()`, run a 3-phase mock; assert exact event sequence.
- **Property-based:** randomly inject events; assert all subscribers see all events in order.

**Demo:** TUI-style log of events scrolling in real time during a Claude run.

**Acceptance:** UI consumers can render live progress; backpressure-safe (slow handlers don't stall pipeline).

**Depends on:** M1.7

---

#### M2.2 — HITL escalation + resume (3 days)

**Built:**
- `EscalationPolicy` reference impls (`always-after-phase`, `confidence-threshold`, `taste-check`)
- `PhaseConfig.requireApproval: true` desugars to `always-after-phase` at graph-compile time; `harness.start()` validation rejects phases that set both `requireApproval` and `escalation` with `HarnessError { kind: 'config-error' }`
- LangGraph `interrupt()` integration → `RunResult.interrupted` path
- `harness.resume(sessionId, humanInput)` → load checkpoint, merge input, continue
- Persistent checkpointer (`SqliteSaver`) for cross-restart resume

**Tests:**
- **Unit:** policy evaluation against fixture states; `requireApproval: true` produces identical event sequence to explicit `escalation: 'always-after-phase'`; setting both fields throws `config-error` at `start()`.
- **Integration:** policy returns `escalate` → graph interrupts → `RunResult.interrupted` → resume continues.
- **End-to-end:** kill the process after escalation; restart; resume from checkpoint.

**Demo:** `taste-check` policy on `plan` phase; run pipeline; observe pause; resume with mock human input; observe completion.

**Acceptance:** Pause/resume works across process restarts.

**Depends on:** M2.1

---

#### M2.3 — Steering inbox (2 days)

**Built:** `harness.steer(sessionId, message)`; `SteeringMessage` queue per session; boundary-pickup default; urgent-interrupt opt-in path.

**Tests:**
- **Unit:** inbox queueing + dedup by id.
- **Integration:** boundary-applied steering reaches next phase via `ctx.steering`.
- **End-to-end (urgent):** start a Claude streaming call; `steer({priority:'urgent'})`; assert phase aborts and re-enters with steering applied.

**Demo:** Mid-pipeline, send "Use the v2 API"; observe next phase incorporating it.

**Acceptance:** Urgent interrupts gated by `capabilities.supportsCancellation`.

**Depends on:** M2.1, M1.6

---

#### M2.4 — `HarnessTool` registry (2 days)

**Built:** `HarnessTool` interface; `ToolContext`; tool registry with per-phase grant filtering; adapter receives `configurable.tools: HarnessTool[]` at invoke; Claude adapter translates to Anthropic tool-use format.

**Tests:**
- **Unit:** registry filters tools by phase grants correctly.
- **Integration:** Claude adapter exposes tools to model; tool-call event flows back through `result.capture.turns`.
- **End-to-end:** phase grants `['memory.query']`; LLM invokes it; tool execution happens; result returned to LLM.

**Demo:** A phase that grants `memory.query` and expects the agent to call it.

**Acceptance:** Tools wire correctly; least-privilege enforced; non-granted tools invisible to LLM.

**Depends on:** M2.1

---

#### M2.5 — In-memory MemoryStore + memory tools (2 days)

**Built:** `InMemoryMemoryStore` with all 4 query types (similarity / graph / structured / recent); built-in `memory.query`, `memory.put`, `memory.recent`, `memory.forget` tools; `MemoryScope` enforcement; per-phase `memory: { read, write }` grants.

**Tests:**
- **Unit:** scope-isolated reads/writes; forget predicate.
- **Integration:** agent calls `memory.put`; subsequent `memory.query` finds the entry.
- **End-to-end:** 2-phase pipeline; phase A writes; phase B retrieves via tool call.

**Demo:** Pipeline writes "user prefers TypeScript" in phase A; phase B's agent retrieves and uses it.

**Acceptance:** Subsystem 1 usable end-to-end with built-in tools.

**Depends on:** M2.4

---

#### M2.6 — Pipeline catalog + coordinator (3 days)

**Built:** `Pipeline`, `PipelineCatalog`, `Coordinator` interface; coordinator-as-agent dispatch flow with admission control; `pipeline.list`, `pipeline.history` built-in tools; output schema validation; admission policy hook.

**Tests:**
- **Unit:** output schema validation rejects malformed coordinator output; admission rejection path returns `RunResult.rejected`.
- **Integration:** `pipeline: 'auto'` triggers coordinator → routes correctly to one of three pipelines.
- **End-to-end:** submit four different inputs, assert routing matches expected pipelines + one rejection.

**Demo:** Three pipelines registered (`prd-greenfield`, `brownfield-ui-enhancement`, `frontend-techstack-upgrade`) + coordinator; submit four inputs (PRD request, UI change, Vue upgrade, malware request); observe correct routing + rejection.

**Acceptance:** Coordinator dispatches and rejects correctly.

**Depends on:** M2.4, M2.5

---

#### M2.7 — Plugin contract + memory-retrieve + memory-write (2 days)

**Built:** `Plugin`, `PluginContext`, `PluginResult`, `PluginFactory`, `RuntimeStateProxy`; orchestrator runs `prePlugins` + `postPlugins`; built-in plugins for memory enrichment.

**Tests:**
- **Unit:** plugin ordering; failure behavior (`fail-phase` vs `continue`); `RuntimeStateProxy` namespace isolation.
- **Integration:** `memory-retrieve` plugin enriches input with memory; `memory-write` plugin extracts insights post-phase.

**Demo:** Pipeline configured with memory-retrieve before `plan` and memory-write after `plan`; observe enrichment + write.

**Acceptance:** Plugin system works; built-in plugins ship; consumers can register custom plugins via `PluginFactory`.

**Depends on:** M2.5

---

#### M2.8 — v0.2 integration demo (1 day)

**Built:** consumer running three pipelines with coordinator + HITL on `review` phase + plugin-driven memory enrichment + full event subscription.

**Tests:** end-to-end exercises all three demo flows.

**Demo:** Three pipelines, four submissions, all routed correctly; one HITL pause + resume.

**Acceptance:** Layer 2 ships ✅

---

## 7. Layer 3 — Durability + extensibility (v0.3)

**Duration:** 1.5 weeks
**Goal:** Git snapshots, three-way rollback, durable config, second adapter (OpenCode CLI).

### 7.1 Acceptance gate

- ✅ Git snapshots round-trip: before-snapshot → phase modifies file → after-snapshot → rollback restores
- ✅ Three-way rollback (filesystem + graph state + session-scoped memory) is transactional
- ✅ `FsConfigStore` watches files and fires `onChange` events
- ✅ OpenCode CLI adapter validates the adapter pattern with a non-SDK backend

### 7.2 Milestones

#### M3.1 — Git snapshot companion package (3 days)

**Built:** `agentic-harness-git-snapshot` package with `GitCommitSnapshot` (always + on-changes modes); structured commit trailers (`X-Harness-Session`, `X-Harness-Phase`, `X-Harness-Checkpoint`); `git diff --quiet` short-circuit for non-mutating phases; `GitWorktreeSnapshot` wrapper for worktree-per-session.

**Tests:**
- **Unit:** trailer formatting; diff-quiet detection.
- **Integration:** in a fixture repo, snapshot.before runs `git status` clean; phase edits a file; snapshot.after commits with correct trailer.
- **End-to-end:** rollback `git reset --hard` restores file content.

**Demo:** Run a phase that edits a file; observe commit; rollback; observe file restored.

**Acceptance:** Real git integration works on darwin + linux.

**Depends on:** M1.7

---

#### M3.2 — Three-way rollback coordination (3 days)

**Built:** Two-phase commit across `SnapshotStrategy.rollback` + `Checkpointer.restore` + `MemoryStore.restore` (when `MemoryStore.snapshot` is supported by the wired backend); failure recovery best-effort with audit log.

**Tests:**
- **Integration:** rollback restores all three coherently for in-memory backends.
- **End-to-end:** simulate process kill mid-rollback (forced via test hook); restart; reconciliation logs inconsistency clearly.

**Demo:** Run pipeline with file edits + memory writes; rollback; assert filesystem + graph + memory all consistent at target phase.

**Acceptance:** No state drift across rollback.

**Depends on:** M3.1

---

#### M3.3 — `FsConfigStore` companion package (2 days)

**Built:** `agentic-harness-config-fs` package with `FsConfigStore` (JSON files + chokidar watch); granular `savePipeline`/`saveProfile`; `harness.start()` wires `configStore.load()`.

**Tests:**
- **Unit:** load/save roundtrips; schema validation on load.
- **Integration:** chokidar fires `onChange` on file edit; new sessions see updated catalog.

**Demo:** Edit `~/.harness/config/pipelines.json`; observe event fires; submit a job; observe updated catalog.

**Acceptance:** Durable config works.

**Depends on:** M2.7

---

#### M3.4 — Runtime pipeline persistence (1 day)

**Built:** `harness.savePipeline(id, pipeline)` validates against build-time registries + persists via `ConfigStore`.

**Tests:**
- **Unit:** validation rejects unknown adapter type; rejects unknown plugin ref.
- **Integration:** save → next session sees pipeline in `pipeline.list` tool.

**Demo:** Add a new pipeline at runtime; assert it's in the catalog for subsequent runs.

**Acceptance:** Coordinator can promote pipelines (foundation for v2 synthesis).

**Depends on:** M3.3

---

#### M3.5 — OpenCode CLI adapter (2 days)

**Built:** `adapters/opencode-cli.ts` — spawns subprocess; parses usage from stdout when available; tokenizer fallback when not; cancellation via SIGINT.

**Tests:**
- **Unit:** stdout parsing for usage extraction.
- **Integration:** spawn opencode with mock model env.
- **End-to-end:** run a real OpenCode task in a fixture repo.

**Demo:** Phase backed by OpenCode adapter modifies a file; observe `git status` shows changes; usage tracked.

**Acceptance:** Adapter pattern validated with non-SDK backend; the abstraction holds.

**Depends on:** M1.4

---

#### M3.6 — v0.3 integration demo (1 day)

**Built:** `brownfield-ui-enhancement` runs against a fixture repo; commits per phase; rollback works; OpenCode adapter for `implement` phase.

**Tests:** end-to-end verifies git history; rollback restores.

**Demo:** Complete UI change → rollback → re-run with different model.

**Acceptance:** Layer 3 ships ✅

---

## 8. Layer 4 — Knowledge subsystem (v0.4)

**Duration:** 1 week
**Goal:** External context (`ContextProvider`), MCP client, cost estimation.

### 8.1 Acceptance gate

- ✅ `ContextProvider` framework wires into `HarnessTool` registry
- ✅ `McpClientProvider` bridges any MCP server
- ✅ One concrete `ContextProvider` (GitHub) ships
- ✅ `harness.estimateCost()` returns sensible ranges (static-heuristic basis)

### 8.2 Milestones

#### M4.1 — `ContextProvider` framework (2 days)

**Built:** `ContextProvider` interface + capabilities + per-phase allowlist enforcement + tool-registration from providers.

**Tests:**
- **Unit:** allowlist filters tools correctly per phase.
- **Integration:** mock provider exposes `provider.search` tool to adapter.

**Demo:** Phase grants `['mock-provider']`; agent invokes the tool; result flows back.

**Acceptance:** Subsystem 2 wired into the tool registry.

**Depends on:** M2.4

---

#### M4.2 — `McpClientProvider` (2 days)

**Built:** Bridges an MCP server's tools/resources into one or more `ContextProvider` entries; tool name translation; auth pass-through.

**Tests:**
- **Integration:** mock MCP server; assert tools auto-register.
- **End-to-end:** real Context7 MCP server (if available) — query package docs.

**Demo:** Provider `mcp:context7`; phase queries package docs; observe response.

**Acceptance:** MCP client integration works.

**Depends on:** M4.1

---

#### M4.3 — GitHub repo provider reference (2 days)

**Built:** `agentic-harness-context-github` companion package — `github.search`, `github.getFile`, `github.tree` tools; auth via `CredentialBroker`.

**Tests:**
- **Unit:** GitHub API request shape.
- **Integration:** mocked HTTP via `nock`.
- **End-to-end (opt-in):** real public-repo query.

**Demo:** Phase queries a real public repo via tool call.

**Acceptance:** One reference impl ships.

**Depends on:** M4.1

---

#### M4.4 — Cost estimation (static-heuristic) (1 day)

**Built:** `harness.estimateCost()` body; `PriceTable` shipped with current Claude/OpenAI pricing; tokenizer-pass on input + per-phase declared knobs to estimate output.

**Tests:**
- **Unit:** estimation math against fixture inputs (deterministic).
- **Integration:** estimate for a real reference pipeline returns plausible range.

**Demo:** Estimate cost for `prd-greenfield/heavy`; observe `expectedDollars` reasonable.

**Acceptance:** Pre-flight cost preview works.

**Depends on:** M2.6

---

#### M4.5 — v0.4 integration demo (1 day)

**Built:** pipeline that uses Confluence + GitHub + memory tools; cost-estimate before submission.

**Tests:** end-to-end — agent makes 3+ tool calls; cost estimate within 30% of actual.

**Demo:** A pipeline with `confluence:eng` + `github:current` granted to phases.

**Acceptance:** Layer 4 ships ✅

---

## 9. Layer 5 — Composition (v0.5)

**Duration:** 1 week
**Goal:** Parallel phase execution.

### 9.1 Acceptance gate

- ✅ `kind: 'parallel'` compiles to LangGraph `Send` API correctly
- ✅ All four merge strategies work
- ✅ Backward compatibility — Layer 1–4 demos run unchanged

### 9.2 Milestones

#### M5.1 — `FlowNode` graph compiler refactor (1 day)

**Built:** Internal refactor of the graph compiler — `Profile.flow: FlowNode[]` with explicit `start: string` entry point. Compiler narrows on `kind` (`phase` / `fork` / `join` / `decision`); each kind compiles to LangGraph nodes + edges directly (no intermediate tree-to-graph step). Validation rejects orphan `next`/`branches`/`goto` references and unmatched `Fork`/`Join` pairs at `harness.start()`. **No public type-surface changes** (FlowNode was already in L1 per § 3.3).

**Tests:**
- **Type-level:** TS narrowing exhaustive on `FlowNode.kind` (Phase / Fork / Join / Decision); missing-case detection compiles-fails.
- **Validation:** orphan-reference rejection, unmatched Fork/Join rejection, cycle detection.
- **Regression:** all Layer 1–4 demos pass without modification (existing demos use only `Phase` kind, which compiles to a linear chain via `next`).

**Acceptance:** No regression. Validation errors cite offending node id + line.

**Depends on:** M4.5

---

#### M5.2 — `Fork` + `Join` parallel composition + subagent worktree allocation (3 days)

**Built:** `Fork` (splitter) compiles to LangGraph `Send` API for fan-out; `Join` (aggregator) compiles to a super-step that aggregates branch results via `ParallelMergeStrategy` (`union`, `first-success`, `voting`, `reducer`). Cancellation propagates to all branches on `first-success`. Every Fork branch triggers subagent worktree allocation (path schema `<jobId>/<subagentId>/<repoName>/` per workspace-template § 4.3.1); branch completion → consolidation by Join's merge strategy → branch worktrees pruned per workspace policy.

**Tests:**
- **Unit:** each merge strategy combines results correctly; `partitionInput` strategies (broadcast / split-by / custom) divide input correctly.
- **Integration:** Fork→[Phase, Phase]→Join executes concurrently, merges, downstream Phase consumes merged result.
- **Workspace integration:** subagent worktree allocation per Fork branch; branches' file changes don't collide; consolidation happens before worktree pruning.

**Demo:** `Fork` running planner + critic in parallel; `Join` with `merge: { type: 'voting' }` picks higher-scoring; downstream `Phase` consumes merged result. Each branch operates against its own subagent worktree set.

**Acceptance:** Concurrent execution works; cancellation cascades; subagent worktrees allocated and pruned correctly; no filesystem collisions across parallel branches.

**Depends on:** M5.1; workspace-template `WT-5a` (multi-repo worktree allocation including subagent dimension).

---

#### M5.3 — v0.5 integration demo (1 day)

**Built:** A `prd-greenfield` profile that uses parallel research + tech-survey, merging via `union`.

**Tests:** end-to-end — observe both branches run concurrently; output combines both.

**Demo:** Submit a PRD task; observe parallel execution.

**Acceptance:** Layer 5 ships ✅

---

## 10. Layer 6 — Polish (v1.0)

**Duration:** 1 week
**Goal:** CLI, conformance kit, reference consumers, docs.

### 10.1 Acceptance gate

- ✅ Unified CLI ships with all v1 subcommands
- ✅ Conformance test kit publishes; both built-in adapters pass
- ✅ Reference consumers (library-only example) work first-try
- ✅ Documentation complete: README + design doc + this plan + per-package READMEs + tutorials
- ✅ Semver lock; CHANGELOG; deprecation policy

### 10.2 Milestones

#### M6.1 — Unified CLI (2 days)

**Built:** `agentic-harness-cli` companion package with subcommands: `memory`, `context`, `pipeline`, `rollback`, `status`, `run`, `submit`. Bun-compiled binary.

**Tests:**
- **Integration:** each subcommand executes against a running harness.
- **Smoke:** CLI parses args correctly; helpful error on bad args.

**Demo:** `harness pipeline run feature-add --profile=heavy --input=./task.json` runs end-to-end.

**Acceptance:** CLI shippable.

**Depends on:** L5

---

#### M6.2 — Conformance test kit (2 days)

**Built:** `agentic-harness-conformance` package — a portable test suite that any third-party adapter imports to validate its `AdapterCapabilities` claims.

**Tests:** suite runs against `claudeSdkAdapter` + `openCodeAdapter` (both pass). A deliberately-broken stub adapter fails with clear errors.

**Demo:** Author a stub adapter that lies about `reportsUsage`; conformance fails as expected with diagnostic.

**Acceptance:** Adapter ecosystem unblocked; third-party authors have a single standard.

**Depends on:** L5

---

#### M6.3 — Reference consumer + docs (2 days)

**Built:**
- `examples/library-only-quickstart.ts` — a library-only consumer demonstrating the v1 surface
- README with quickstart, concepts, FAQ
- TypeDoc-generated API reference from JSDoc
- Tutorials: "Your first pipeline", "Writing a custom adapter", "Adding a context provider"

**Tests:** README's quickstart commands copy verbatim to a new directory and work.

**Demo:** Run the quickstart on a fresh dev box.

**Acceptance:** Onboarding ergonomics validated.

**Depends on:** M6.1, M6.2

---

#### M6.4 — v1.0 release (1 day)

**Built:** semver lock + CHANGELOG + deprecation policy doc + GitHub release with binaries for darwin + linux.

**Demo:** Public 1.0 announcement.

**Acceptance:** API stability commitment locked.

**Depends on:** M6.3

---

## 11. Layer 7 — Multi-job runtime (post-v1; separate project)

**Duration:** 2 weeks
**Goal:** `agentic-harness-runtime` package + GitHub source/sink reference + autonomous-mode demo.

### 11.1 Acceptance gate

- ✅ Workspace runs many concurrent jobs in distinct worktrees + DevContainers without conflict
- ✅ GitHub issues → workspace → PR opens cleanly
- ✅ Drain on SIGTERM completes in-flight jobs

### 11.2 Milestones

#### M7.1 — `agentic-harness-runtime` core (5 days)

**Built:** `Workspace`, `JobQueue` (in-memory + sqlite + Postgres impls), `WorktreeManager`, worker loop, concurrency permits, `WorkspaceHooks`.

**Tests:**
- **Unit:** queue ordering by priority + scheduling.
- **Integration:** worker loop processes jobs concurrently up to limit.
- **Concurrency:** chaos-test — kill workers mid-job; assert queue recovers.

**Demo:** Submit 5 jobs; observe 2 concurrent workers; rest queue.

**Acceptance:** Multi-job orchestration works on a single machine.

---

#### M7.2 — GitHub source + sink reference impl (3 days)

**Built:** `agentic-harness-source-github` (poll + webhook) and `agentic-harness-sink-github` (open PR, comment on issue).

**Tests:**
- **Integration:** mocked GitHub API.
- **End-to-end:** real GitHub repo with test labels.

**Demo:** Label an issue → workspace picks up → pipeline runs → PR opens with worktree branch.

**Acceptance:** One end-to-end autonomous flow.

---

#### M7.3 — v1.5 integration demo (2 days)

**Built:** Autonomous workspace responding to GitHub issues with a label.

**Tests:** end-to-end label → PR within minutes.

**Demo:** Real demo on a fixture repo.

**Acceptance:** Layer 7 ships ✅

---

## 12. PRD ecosystem deliverables — when they integrate

The PRD defines seven deliverables that ship in parallel with library work, gated on the library APIs they depend on.

```
Library Layer 1 (week 2)
   ├──> MemoryStore CLI (PRD §6) — needs MemoryStore + HarnessTool interfaces
   │     (~5 days; can start in week 3)
   │
   └──> GraphRAG Server (PRD §7) — needs ContextProvider interface (Layer 4)
         (~10 days; starts week 7 after Layer 4 stable; or build in
          parallel against just-the-types if happy with that risk)

Library Layer 3 (week 5)
   └──> Harness-Server (PRD §8) — needs runtime layer types (already in L1
        per "fully-typed" discipline) + persistent storage primitives
        (~10 days; can start in week 5)

Library Layer 4 (week 6)
   └──> TUI (PRD §9) — needs Harness-Server's WebSocket event stream
        (~7 days; starts week 8)

Library Layer 5 (week 7)
   └──> VS Code Extension (PRD §10) — needs Harness-Server REST + WS
        (~8 days; starts week 9)

Library Layer 6 (week 7)
   └──> Workspace Template (PRD §11) — needs all preceding deliverables
        (~7 days; starts week 9)
        └──> Workspace Setup CLI (PRD §12) — orchestrates everything
              (~6 days; starts week 11)
```

### 12.1 Critical-path sequencing

```
M1.7 (library v0.1) ──┬─> MemoryStore CLI (parallel, starts week 3)
                      │
                      ├─> Harness-Server v0.1 (week 5) ──> TUI (week 8)
                      │                                      │
                      │                                  VS Code Ext (week 9)
                      │                                      │
                      └─> Workspace Template (week 9)        │
                            │                                │
                            └─> Workspace Setup CLI (week 11) ─────┘
                                  │
                            v1.0 ecosystem complete (week 13–14)
```

---

## 13. Refactoring risks (and their mitigations)

Three risks remain even with the "fully-typed" discipline:

### 13.1 Graph compiler internal refactor (Layer 5)

**Risk:** Adding parallel composition restructures `core/graph.ts`. Internal change; public types unchanged.

**Mitigation:** Keep `core/graph.ts` small in Layer 1 (target <300 lines). Refactoring 300 lines is fine; refactoring 3000 would not be. Comprehensive integration tests in Layer 1 catch regressions.

**Probability:** High (definitely happens).
**Blast radius:** Internal only. No public API changes.

### 13.2 `RuntimeStateProxy` shape evolution (Layer 2 learning)

**Risk:** First plugin authors may hit missing accessors on `RuntimeStateProxy`. The interface evolves based on real usage.

**Mitigation:** Mark `RuntimeStateProxy` as `@experimental` until v0.2 ships several real plugins. Stabilize in Layer 2's release notes. Plugins that need an accessor we didn't ship can use `as any` escape with a comment.

**Probability:** Medium.
**Blast radius:** Plugin authors only (small population in early days).

### 13.3 Three-way rollback semantics (Layer 3 learning)

**Risk:** Real-world rollback edge cases (process killed mid-rollback, partial reconciliation, concurrent rollbacks) reveal gaps in two-phase commit semantics.

**Mitigation:** Layer 3's `M3.2` includes chaos tests (forced kills mid-rollback). Internal-only changes; public signature `rollback(sessionId, toPhase)` doesn't change. Document semantics carefully + add audit logging for any inconsistency.

**Probability:** Medium.
**Blast radius:** Internal only.

---

## 14. Test strategy in detail

### 14.1 Test tiers

| Tier | Purpose | Tooling | Run on |
|---|---|---|---|
| **Unit** | Isolated function/method validation | Vitest | every commit |
| **Type-level** | Discriminated-union narrowing, generic constraints | `tsd` / `expect-type` | every commit |
| **Integration** | Multiple modules wired together (no real external deps) | Vitest + `nock` | every commit |
| **End-to-end (mocked)** | Full pipeline with VCR cassettes | Vitest + cassette playback | every PR |
| **End-to-end (real)** | Full pipeline with real Anthropic key | Vitest + opt-in env | nightly + pre-release |
| **Conformance** | Adapter contract validation | `agentic-harness-conformance` | every PR for adapter packages |
| **Performance / load** | Throughput, latency under load | k6 / autocannon | weekly |
| **Chaos** | Resilience (kill workers, drop network, etc.) | toxiproxy + custom | pre-release |

### 14.2 CI matrix

| Dimension | Values |
|---|---|
| OS | macOS-latest, ubuntu-latest |
| Node | 22.x |
| Runtime | Node + Bun (where applicable) |
| Anthropic key | Mocked (default) + real (nightly job) |

### 14.3 Coverage targets

- `src/types/`: 100% (type-level tests)
- `src/impl/`: ≥80% line + branch
- Adapters: ≥85% (conformance kit forces this)
- Critical paths (orchestrator, error, retry, snapshot): 100% line, ≥90% branch

### 14.4 Demo / acceptance test convention

Every milestone has a `examples/<milestone-id>-demo.ts` runnable example. CI runs each demo against mocked dependencies; one nightly job runs the latest demo against real Anthropic key.

---

## 15. Resource requirements

### 15.1 People

For the schedule to hold (12 weeks to ecosystem v1.0):

- **1 senior TypeScript engineer (full-time):** library Layers 1–6 + harness-server.
- **1 TypeScript engineer (full-time):** ecosystem deliverables (MemoryStore CLI, GraphRAG, TUI, VS Code extension, installer).
- **0.25 FTE design / DevEx review:** API ergonomics, doc reviews, onboarding flows.
- **0.25 FTE security review (concentrated in M3.2 + Layer 6 + Phase 3 of PRD):** capture redaction, prompt injection, sandbox boundaries.

Solo full-time: ~16–18 weeks instead of 12.

### 15.2 Infrastructure

- GitHub repository (monorepo, pnpm workspaces matching the existing layout)
- npm publish access for `@your-org` scope
- GitHub Actions (or equivalent CI)
- Anthropic API key budget (~$200/month for nightly E2E + dev)
- Optional: Postgres + Redis test instances (Phase 3)

### 15.3 Existing assets to leverage

- The user's existing pnpm monorepo at `npm-dependency/`
- Existing `mtauth` packages for auth integration
- Existing CLI patterns in `npm-dependency/*-cli/` (commit conventions, build setup)
- HeroUI v3 for any web-facing interfaces (per user memory)

---

## 16. Deliverable checklist

The combined checklist across all phases. Phase 1 = library v0.1–v0.3 + early ecosystem. Phase 2 = library v0.4–v1.0 + remaining ecosystem. Phase 3 = polish + production hardening.

### Phase 1 (weeks 1–8)

- [ ] Layer 0 spike + design-doc revisions (week 1)
- [ ] Library v0.1 (M1.1–M1.7) — week 1–2
- [ ] Library v0.2 (M2.1–M2.8) — week 3–4
- [ ] Library v0.3 (M3.1–M3.6) — week 4–5
- [ ] MemoryStore CLI (PRD §6) — week 3–4
- [ ] GraphRAG Server v0.1 (PRD §7) — week 5–7
- [ ] Harness-Server v0.1 (PRD §8) — week 5–7
- [ ] Workspace Template v0.1 (PRD §11) — week 7–8

### Phase 2 (weeks 8–12)

- [ ] Library v0.4 (M4.1–M4.5) — week 6–7
- [ ] Library v0.5 (M5.1–M5.3) — week 7–8
- [ ] Library v1.0 (M6.1–M6.4) — week 8–9
- [ ] TUI (PRD §9) — week 8–10
- [ ] VS Code Extension (PRD §10) — week 9–11
- [ ] Workspace Setup CLI (PRD §12) — week 11–12

### Phase 3 (weeks 12–16; optional)

- [ ] Library v1.x — Layer 7 runtime (post-v1)
- [ ] Harness-Server multi-instance + Helm chart
- [ ] Conformance + reference docs polish
- [ ] Production hardening (security review, perf tuning, monitoring)

---

## 17. Open questions

| # | Question | Decision needed by |
|---|---|---|
| IP1 | Does Layer 0 spike use real LangGraph TS, or first explore alternatives (e.g., custom state machine)? | Day 1 |
| IP2 | Bun or Node for Layer 1? Bun gives faster test iteration; Node has wider ecosystem. | Layer 1 start |
| IP3 | VCR cassette tool — `polly.js`, custom, or `nock --record`? Affects E2E test maintainability. | Layer 1 week 1 |
| IP4 | Should `core/graph.ts` use LangGraph's StateGraph directly or wrap it? Wrapper gives flexibility; direct gives less code. | Layer 1 M1.2 |
| IP5 | Coverage gates in CI — should missing coverage fail PR or just warn? | Layer 1 |
| IP6 | Workspace template repo location — same monorepo or separate? Affects installer logic. | Phase 1 week 6 |
| IP7 | Conformance test kit — published as npm package or in-repo only? | Layer 6 |
| IP8 | Pricing table in `CostEstimate` — hardcoded with periodic updates, or fetched from a hosted JSON? | Layer 4 M4.4 |

---

## 18. Glossary (plan-specific)

| Term | Meaning |
|---|---|
| **Layer** | A vertical implementation slice in this plan (Layer 0–7); each ends with an acceptance gate. |
| **Milestone** | A unit of work within a layer with explicit deliverables and tests (e.g., M1.3). |
| **Acceptance gate** | The criteria that must be green before the next layer/milestone starts. |
| **Spike** | Throwaway exploratory code that validates a design assumption. |
| **VCR cassette** | A recorded HTTP interaction that can be replayed in tests deterministically. |
| **Conformance** | A portable test suite that adapter authors run to verify their `AdapterCapabilities` claims. |
| **Demo** | A runnable example that exercises the milestone's public surface. |
| **Backward-compatible refactor** | A change that doesn't modify public types/signatures (only internal code). |

---

*End of implementation plan.*

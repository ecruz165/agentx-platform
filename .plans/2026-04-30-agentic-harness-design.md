# Agentic Harness — Design Doc

**Status:** Draft — pending decisions on Q1, Q2, Q4–Q31 (Q3 retired)
**Date:** 2026-04-30
**Author:** Edwin Cruz
**Audience:** Design reviewers, future implementers

> A reusable TypeScript library that orchestrates phased agent pipelines on top of LangGraph, with pluggable agent backends (Claude SDK, OpenCode CLI wrapper, others), centralized credential management, in-adapter token tracking + capture, human-in-the-loop escalation, runtime steering, git-based state snapshots, internal memory, external context providers, a unified tool/skill registry, named profiles, a top-level pipeline catalog with a coordinator agent for admission + dispatch, durable config persistence, structured logging, typed error taxonomy with declarative retry, progress event streams, cancellation API, cost estimation, phase composition (parallel / conditional / loop / sub-pipeline), and an optional multi-job runtime layer for local-mode and autonomous-workspace operation. The "central server" pattern is a deployment topology wired via existing source/sink/transport adapter interfaces — not a layer in the library.

---

## 1. Summary

The harness has three concentric layers, each opt-in for the consumer:

1. **Core library** — phase orchestration, agent abstraction, credential broker, memory + context subsystems, tool registry, profiles, pipeline catalog, coordinator agent for admission + dispatch. Single-shot `harness.run(input, opts)`.
2. **Runtime layer** (companion package) — `Workspace`, `JobQueue`, `WorktreeManager`, `JobSource`, `JobSink`. Manages many concurrent jobs; supports local-mode (CLI-driven) and autonomous-mode (unattended workers).
3. **Central-server pattern** (consumer choice) — when a consumer wants centralized control across many workers, they wire JobSources, JobSinks, ConfigStore, log transport, and event subscribers to point at their server. The library and runtime ship the interfaces; the server itself is a deployment artifact, not a layer in the library.

Cross-cutting features that span layers:

- **`AgentAdapter` abstraction** — Claude SDK, OpenCode CLI wrapper, OpenAI, custom backends — all uniformly composable as LangChain `Runnable`s.
- **`CredentialBroker`** owns provider credentials and lends them to adapters at invocation time.
- **In-adapter observability** — token usage and optional request/response capture aligned with OpenTelemetry GenAI conventions.
- **First-class HITL** — phases interrupt, persist, and resume via LangGraph checkpointer.
- **First-class steering** — mid-flight human guidance; boundary-applied by default, urgent-interrupt opt-in.
- **Pluggable snapshots** — phase boundaries capture filesystem state (git) + graph state (checkpointer); rollback transactional across both + session-scoped memory.
- **Two distinct knowledge subsystems with a unified surface** — `MemoryStore` (internal stateful R/W, scope-aware, GDPR, rollback participant) and `ContextProvider[]` (external read-mostly retrieval clients with rate limits, caching, per-provider auth). Both feed the same `HarnessTool` registry.
- **Profiles** — level-of-effort bundles within a pipeline (lightweight / standard / heavy).
- **Pipeline catalog + coordinator agent** — many specialized pipelines coexist; a single configurable coordinator agent performs admission control (`accept`/`reject`) and routes to the proper pipeline + profile.
- **Durable config substrate** — `ConfigStore` loads catalog from files (or DB / S3) and persists runtime additions.
- **Structured logging, typed errors, declarative retry, progress events, cancellation, cost estimation** — production-grade observability + control surfaces.
- **Phase composition** — sequence (default), parallel, conditional, loop, sub-pipeline.

The library ships interfaces, not implementations, for everything that touches the host environment. Consumers wire their own.

## 2. Goals

- **Reusable across consumers** — one library serves CLI, web app, embedded, and autonomous-runtime use cases.
- **Pluggable agent backends, plugins, providers, sources, sinks** — adding a new variant is a single factory registration.
- **Configuration without recompilation** — phase wiring, agent selection, profiles, pipeline catalog, per-phase tool/context grants, runtime concurrency settings — all data, not code.
- **Centralized credentials** — secrets owned by the harness, lent at invocation, refreshed transparently, scope-policy gated.
- **Observable by default** — structured token usage, optional capture, structured progress events, structured logs.
- **Resumable execution** — pipelines suspend on escalation, persist via checkpointer, resume across process restarts.
- **Rollback-capable** — phase-boundary checkpoints, transactional across filesystem, graph state, and session-scoped memory.
- **Agent-initiated knowledge access** — memory and external context surfaced as tools the LLM invokes, with per-phase least-privilege grants.
- **Multi-pipeline orchestration with admission control** — coordinator agent gatekeeps and routes; many specialized pipelines coexist.
- **Multi-job operation** — `Workspace` manages concurrent jobs, with isolation via per-job git worktrees; same primitives serve local-mode and autonomous-mode.
- **Composable phases** — parallel, conditional, loop, and sub-pipeline composition for non-linear pipelines.

## 3. Non-goals

- **Not a CLI itself.** Reference CLI ships in a separate companion package.
- **Not a hosted service or central server.** Server-deployment topology is a consumer choice; the library defines no server protocol.
- **Not an OAuth implementation.** Library defines `Provider` shapes and refresh; flow handlers live in consumer code.
- **Not a tracing/observability platform.** Library emits OpenTelemetry-shaped events; storage and visualization are downstream.
- **Not a model router.** Config picks; if you want fallback, register a wrapper adapter.
- **Not a prompt management system.** Prompts are inputs to adapters.
- **Not an MCP server.** v1 is an MCP *client* via `McpClientProvider`; full MCP server compliance is post-v1.
- **Not adaptive routing inside a pipeline.** v1 expects pipeline + profile selected at session start (or via coordinator dispatch); in-pipeline routing is post-v1.
- **Not pipeline synthesis in v1.** Coordinator selects from catalog in v1; synthesis is v2.
- **Not in-flight config hot-reload.** When `ConfigStore` notifies of changes, only *new* sessions/jobs pick them up.
- **Not multi-process workers in v1.** v1 ships in-process worker pool; multi-process and external worker (Bull-style) models are v2.
- **Not external job systems integration in v1.** Temporal/Airflow integration is consumer-wired post-v1.
- **Not a quota/billing system.** Per-tenant/per-user quota enforcement is consumer concern; harness's `BudgetGate` plugin handles per-session.

## 4. Concept overview

### 4.1 The library (single-shot)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Library — created via createHarness({...})                         │
│                                                                     │
│  Build-time registries (code):                                      │
│    AdapterFactory[]  PluginFactory[]  Provider[]                    │
│    SnapshotStrategy[]  HarnessTool[]                                │
│    ContextProviderFactory[]                                         │
│                                                                     │
│  ConfigStore.load() ──► HarnessConfig:                              │
│    coordinator: { agent, outputSchema, ... }   ← single agent       │
│    pipelines: { 'prd-greenfield', 'brownfield-ui-enhancement', … }  │
│    each pipeline has profiles: { lightweight, standard, heavy }     │
│    each profile has phaseNodes: [PhaseConfig | ParallelNode | ... ] │
│                              │                                      │
│  harness.run(input, { pipeline, profile, … })                       │
│                              │                                      │
│  if pipeline === 'auto' AND coordinator is configured:              │
│    invoke coordinator.agent (single agent call)                     │
│    validate output { accept, pipelineId?, profile?, … }             │
│    if accept===false: return RunResult { status: 'rejected' }       │
│    if accept===true:  dispatch to pipelineId / profile              │
│                              │                                      │
│                              ▼                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ LangGraph StateGraph (per pipeline run)                       │  │
│  │   composes phaseNodes: sequence / parallel / conditional /    │  │
│  │   loop / sub-pipeline                                         │  │
│  │   Around each phase node: pre/post plugins, snapshot,         │  │
│  │   escalation, usage rollup, capture                           │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  Public API: run, cancel, resume, steer, rollback, events,          │
│              estimateCost, savePipeline                             │
└─────────────────────────────────────────────────────────────────────┘
       ▲       ▲         ▲          ▲          ▲          ▲
       │       │         │          │          │          │
   Credential Session Capture   MemoryStore ContextProv ConfigStore
   Broker     Store   Sink      (subsystem) (subsystem) (durable)
   (iface)    (iface) (iface)   (iface)     (iface)     (iface)
       ▲       ▲         ▲          ▲          ▲          ▲
       │       │         │          │          │          │
   consumer-supplied implementations
```

### 4.2 The runtime layer (multi-job, optional)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Runtime — created via createWorkspace({...})  [opt-in package]     │
│                                                                     │
│  JobSources[] ──► JobQueue.enqueue() ──► Worker pool                │
│                                          (concurrency-limited)      │
│                                                  │                  │
│                                                  ▼                  │
│                                          for each job:              │
│                                          1. acquire worktree        │
│                                          2. harness.run(...)        │
│                                          3. JobSinks[] ◄────────    │
│                                          4. release worktree        │
│                                                                     │
│  Public API: workspace.run({mode}), submit, status, cancel,         │
│              listJobs, drain, onEvent                               │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼ uses
                       (the library above)
```

### 4.3 The central-server pattern (consumer deployment topology)

```
                  ┌─────────────────────────────┐
                  │ Central Server              │   (consumer-built or
                  │   • job queue (Redis/PG)    │    community package;
                  │   • config store (DB)       │    NOT in this library)
                  │   • log aggregator          │
                  │   • event subscriber        │
                  │   • monitoring UI           │
                  └─────────────────────────────┘
                       ▲                    ▲
                  ┌────┘                    └────┐
                  │ JobSource              JobSink
                  │ + Logger transport    + EventBus transport
                  │ + RemoteConfigStore
                  │
   ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
   │ Worker A         │    │ Worker B         │    │ Worker N         │
   │ (workspace +     │    │ (workspace +     │    │ (workspace +     │
   │  library)        │    │  library)        │    │  library)        │
   └──────────────────┘    └──────────────────┘    └──────────────────┘
```

The library and runtime ship the interfaces; the central server itself is a deployment artifact, not a layer.

## 5. Package layout (proposed)

```
npm-dependency/
  agentic-harness/                    ← core library (this doc's primary scope)
    package.json
    tsconfig.json
    src/
      core/
        harness.ts                    createHarness(), Harness interface
        graph.ts                      LangGraph StateGraph builder, FlowNode (Phase/Fork/Join/Decision) compilation
        runtime-context.ts            RuntimeContext type
        config.ts                     HarnessConfig, validation, profile + pipeline merge
        events.ts                     HarnessEvent emission + subscription
        errors.ts                     HarnessError taxonomy
        retry.ts                      RetryPolicy + default impls
        cost.ts                       CostEstimate + price table
      adapters/
        types.ts                      AgentAdapter, AdapterFactory, AdapterCapabilities
        base.ts                       BaseAgentAdapter (defaults)
        claude-sdk.ts                 Anthropic SDK adapter
        opencode-cli.ts               OpenCode CLI wrapper adapter
        openai.ts                     OpenAI SDK adapter
      providers/
        types.ts                      Provider, AuthFlow
        anthropic.ts
        openai.ts
        github-copilot.ts
        bedrock.ts
      auth/
        broker.ts                     CredentialBroker interface + default impl
        store.ts                      CredentialStore interface
      observability/
        logger.ts                     Logger interface + console/noop impls + adapters
        usage.ts                      TokenUsage, UsageRollup, estimateUsage()
        capture.ts                    CaptureLedger, CaptureSink interface
        redaction.ts                  RedactionPolicy interface + defaults
      phases/
        types.ts                      Phase, Fork, Join, Decision (FlowNode discriminated union; see § 6.6)
        orchestrator.ts               phase execution wrapper
        composition.ts                parallel / conditional / loop / sub-pipeline compilation
      pipelines/
        types.ts                      Pipeline, PipelineCatalog
        coordinator.ts                Coordinator interface + dispatch flow + pipeline.list tool
        validation.ts                 pipeline validation against build-time registries
      plugins/
        types.ts                      Plugin, PluginFactory, PluginContext, PluginResult
        builtin/                      retry, rate-limit, budget-gate, memory-retrieve,
                                      memory-write, critique
      hitl/
        escalation.ts                 EscalationPolicy, EscalationRequest
        steering.ts                   SteeringMessage, steering inbox
      snapshots/
        types.ts                      SnapshotStrategy, SnapshotRef
        memory.ts                     MemorySnapshot
      sessions/
        store.ts                      SessionStore interface
      memory/
        types.ts                      MemoryStore interface, MemoryScope, MemoryQuery, MemoryEntry
        in-memory.ts                  InMemoryMemoryStore
      context/
        types.ts                      ContextProvider interface, ContextQuery, ContextResult
        mcp-client.ts                 McpClientProvider
      tools/
        types.ts                      HarnessTool, ToolContext, ToolResult
        builtin/                      memory.*, snapshot.*, escalation.request, pipeline.list,
                                      pipeline.history
        registry.ts
      config-store/
        types.ts                      ConfigStore interface, ConfigChangeEvent
        in-memory.ts                  InMemoryConfigStore
      policies/
        types.ts                      Policy<TInput, TDecision>
      profiles/
        types.ts
      index.ts                        public API surface
    test/

  agentic-harness-runtime/            ← multi-job runtime layer (companion)
    src/
      workspace.ts                    createWorkspace(), Workspace interface
      job.ts                          Job, JobLifecycle, JobFilter
      queue/
        types.ts                      JobQueue interface
        in-memory.ts                  InMemoryJobQueue
      worktree.ts                     WorktreeManager interface
      worker-loop.ts                  the per-worker dispatch loop
      sources/
        types.ts                      JobSource interface
        cli.ts                        CliJobSource
        file-watcher.ts               FileWatcherSource
      sinks/
        types.ts                      JobSink interface
        file.ts                       FileSink
        return.ts                     ResultReturnSink (for synchronous local-mode)
      concurrency.ts                  ConcurrencyConfig + permit acquisition
      hooks.ts                        WorkspaceHooks
      index.ts
```

Optional companion packages:

```
npm-dependency/
  # snapshot strategies
  agentic-harness-git-snapshot/       ← GitCommitSnapshot, GitWorktreeSnapshot

  # checkpointers (or use upstream LangGraph)
  agentic-harness-checkpointer-pg/

  # config stores
  agentic-harness-config-fs/          ← FsConfigStore (chokidar watch)
  agentic-harness-config-s3/

  # memory stores
  agentic-harness-memory-neo4j/       ← graph MemoryStore
  agentic-harness-memory-pgvector/    ← vector MemoryStore

  # context providers
  agentic-harness-context-github/
  agentic-harness-context-confluence/
  agentic-harness-context-openapi/
  agentic-harness-context-linear/

  # job queues
  agentic-harness-jobqueue-fs/        ← FsJobQueue (file-locking)
  agentic-harness-jobqueue-sqlite/    ← SqliteJobQueue
  agentic-harness-jobqueue-redis/     ← RedisJobQueue
  agentic-harness-jobqueue-bullmq/    ← BullMqAdapter

  # job sources
  agentic-harness-source-github/      ← GitHubIssueSource (poll/webhook)
  agentic-harness-source-linear/      ← LinearTicketSource
  agentic-harness-source-cron/        ← CronSource
  agentic-harness-source-webhook/     ← WebhookSource (HTTP)

  # job sinks
  agentic-harness-sink-github/        ← GitHubPrSink, GitHubIssueCommentSink
  agentic-harness-sink-slack/
  agentic-harness-sink-webhook/

  # logger adapters
  agentic-harness-logger-pino/
  agentic-harness-logger-winston/

  # central-server pattern (community / consumer)
  agentic-harness-control-plane-client/   ← canonical impls of source+sink+logger transport+
                                             RemoteConfigStore for a "central server" deployment

  # CLI
  agentic-harness-cli/                ← unified CLI (memory, context, rollback, pipeline, job ops)
```

## 6. Core primitives

### 6.1 `AgentAdapter`

```ts
interface AgentAdapter extends Runnable<AgentInput, AgentInvocationResult> {
  readonly providers: readonly string[];
  readonly capabilities: AdapterCapabilities;

  invoke(
    input: AgentInput,
    config: RunnableConfig & { configurable: HarnessConfigurable }
  ): Promise<AgentInvocationResult>;

  stream?(
    input: AgentInput,
    config: RunnableConfig & { configurable: HarnessConfigurable }
  ): AsyncIterable<AgentChunk>;
}

interface AdapterCapabilities {
  reportsUsage: boolean;
  supportsCapture: boolean;
  supportsStreaming: boolean;
  supportsToolUse: boolean;
  supportsExtendedThinking: boolean;
  supportsCancellation: boolean;
  honorsSeed: boolean;
}
```

### 6.2 `AdapterFactory`

```ts
interface AdapterFactory<TSpec extends AgentSpec = AgentSpec> {
  readonly type: TSpec['type'];
  readonly schema: ZodSchema<TSpec>;
  readonly capabilities: AdapterCapabilities;
  readonly lifecycle: 'singleton' | 'per-session' | 'per-invocation';
  create(spec: TSpec, deps: AdapterDeps): AgentAdapter | Promise<AgentAdapter>;
}

interface AdapterDeps {
  credentialBroker: CredentialBroker;
  logger: Logger;
  signal?: AbortSignal;
}
```

### 6.3 `AgentSpec`

Discriminated union with full normalized verbs.

```ts
type AgentSpec =
  | ({ type: 'claude-sdk' } & ClaudeAgentSpec)
  | ({ type: 'opencode-cli' } & OpenCodeAgentSpec)
  | ({ type: 'openai' } & OpenAIAgentSpec)
  | ({ type: string } & UnknownAgentSpec);

interface ClaudeAgentSpec {
  model: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  seed?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  thinking?: { budgetTokens: number };
  systemPrompt?: string;
  extra?: Record<string, unknown>;
}

interface OpenAIAgentSpec {
  model: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  seed?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  systemPrompt?: string;
  extra?: Record<string, unknown>;
}

interface OpenCodeAgentSpec {
  model: string;
  binaryPath?: string;
  configFile?: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  systemPrompt?: string;
  flags?: Record<string, string | boolean>;
  extra?: Record<string, unknown>;
}
```

#### Normalized verb mapping

| Normalized verb | Anthropic | OpenAI | Notes |
|-----------------|-----------|--------|-------|
| `model` | `model` | `model` | Required |
| `maxTokens` | `max_tokens` | `max_completion_tokens` (o-series) / `max_tokens` | Adapter routes by model class |
| `temperature` | `temperature` (0–1) | `temperature` (0–2) | Adapter rescales; o-series ignores |
| `topP` | `top_p` | `top_p` | Use either temperature *or* topP |
| `stopSequences` | `stop_sequences` | `stop` | Direct rename |
| `seed` | not natively supported | `seed` | Anthropic adapter ignores or warns |
| `systemPrompt` | `system` | first system message | Direct mapping |
| `reasoningEffort: 'low'` | `thinking: { budget_tokens: 4000 }` | `reasoning: { effort: 'low' }` | Conventional thresholds |
| `reasoningEffort: 'medium'` | `thinking: { budget_tokens: 16000 }` | `reasoning: { effort: 'medium' }` | — |
| `reasoningEffort: 'high'` | `thinking: { budget_tokens: 32000 }` | `reasoning: { effort: 'high' }` | — |
| `thinking.budgetTokens` (override) | `thinking: { budget_tokens: N }` | n/a | Anthropic-specific escape |
| `extra` | spread into request | spread into request | Untyped escape |

### 6.4 `AgentInvocationResult`

> **TODO (user contribution):** finalize this shape. See § 9 / Q5 / Q6.

```ts
interface AgentInvocationResult<T = unknown> {
  output: T;
  usage?: TokenUsage;
  capture?: AgentCapture;
  metadata: {
    providerId: string;
    model?: string;
    durationMs: number;
    finishReason?: 'stop' | 'length' | 'tool_use' | 'content_filter' | 'error';
  };
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
  source: 'reported' | 'estimated';
  raw?: unknown;
}

interface AgentCapture {
  request?: unknown;
  response?: unknown;
  turns?: AgentTurn[];
  redactedFields?: string[];
}
```

### 6.5 `Phase` and `PhaseConfig`

A phase has a natural three-step rhythm: **enrich → work → consolidate**, expressed via `prePlugins` (enrich), `agent` (work), `postPlugins` (consolidate). Each phase configures its own enrich and consolidate independently.

```ts
interface PhaseConfig {
  id: string;
  agent: AgentSpec | { ref: string };

  inputs?: PhaseInputContract;
  outputs?: PhaseOutputContract;

  prePlugins?: PluginRef[];
  postPlugins?: PluginRef[];

  // Per-phase access grants
  memory?: { read: boolean; write: boolean };
  contextProviders?: string[];
  tools?: string[];

  escalation?: EscalationPolicyRef;
  requireApproval?: boolean;
  snapshot?: { strategy: SnapshotStrategyRef; when: 'always' | 'on-changes' | 'never' } | false;
  retry?: RetryPolicy;
  timeoutMs?: number;
}
```

**`requireApproval` — declarative force-HITL flag.** When `true`, the orchestrator unconditionally raises an `EscalationRequest` after the phase's agent invocation completes, regardless of result content. Equivalent to wiring `escalation: 'always-after-phase'`, but visible directly in the phase config so pipeline designers don't need to know which policy is registered to express "human must approve this step." Pairs naturally with `outputs` contracts on review-gate phases.

**Mutual exclusion with `escalation`.** Setting both `requireApproval: true` and `escalation: <ref>` is a config-error caught at `harness.start()` validation — pipelines should pick one mechanism per phase. Rationale: a single source of truth for *did this phase escalate?* keeps the orchestrator's gate logic and audit log unambiguous. If composition (e.g., "always force HITL AND also run taste-check") is needed later, it's a non-breaking addition to loosen this rule.

### 6.6 `FlowNode` — composition (Phase / Fork / Join / Decision)

A `Profile.flow` is a flat array of `FlowNode`s with explicit `next` / `branches` edges encoding a directed graph. This is graph-native — it maps directly onto LangGraph's underlying state machine without an intermediate tree-to-graph compile step — and uses BPMN / Apache Camel EIP vocabulary (Splitter / Aggregator) that pipeline authors typically already know.

```ts
// Base — every node has an id and zero-or-more outgoing edges
interface FlowNodeBase {
  id: string;
  next?: string | string[];          // id(s) of downstream node(s); shape varies by kind
}

// Discriminated union of all flow-node kinds
type FlowNode = Phase | Fork | Join | Decision;

// --- Phase: does the actual work ---
interface Phase extends FlowNodeBase {
  kind: 'phase';
  agent: AgentSpec | { ref: string };

  inputs?:  PhaseInputContract;
  outputs?: PhaseOutputContract;

  prePlugins?:  PluginRef[];
  postPlugins?: PluginRef[];

  memory?:           { read: boolean; write: boolean };
  contextProviders?: string[];
  tools?:            string[];

  escalation?:       EscalationPolicyRef;
  requireApproval?:  boolean;
  snapshot?:         { strategy: SnapshotStrategyRef; when: 'always' | 'on-changes' | 'never' } | false;
  retry?:            RetryPolicy;
  timeoutMs?:        number;

  next?: string;                     // exactly one outgoing edge for a Phase
}

// --- Fork: splitter — emits one input to N parallel paths ---
interface Fork extends FlowNodeBase {
  kind: 'fork';
  branches: string[];                // ids of the first node in each parallel path
  partitionInput?:                   // how the input is divided across branches
    | { strategy: 'broadcast' }                                          // every branch sees same input (default)
    | { strategy: 'split-by'; field: string }                            // input.<field> is an array; one branch per element
    | { strategy: 'custom'; fn: (input: AgentInput) => AgentInput[] };   // consumer-supplied
  joinAt: string;                    // id of the matching Join (validated at compile time)
}

// --- Join: aggregator — synchronizes N paths into one ---
interface Join extends FlowNodeBase {
  kind: 'join';
  forkId: string;                    // back-reference to the matching Fork (validated at compile time)
  merge: ParallelMergeStrategy;      // how branch results are consolidated
  next?: string;                     // single downstream edge after the join
}

// --- Decision: conditional routing (N-way; optional in v1) ---
interface Decision extends FlowNodeBase {
  kind: 'decision';
  routes: Array<{ when: PhasePredicate; goto: string }>;
  fallback?: string;                 // node id when no `when` matches; if omitted → fail with config-error
}

type ParallelMergeStrategy =
  | { type: 'union' }
  | { type: 'first-success' }
  | { type: 'voting';  selector: (results: AgentInvocationResult[]) => number }
  | { type: 'reducer'; reduce:   (results: AgentInvocationResult[]) => unknown };

type PhasePredicate =
  | { type: 'expression'; expression: string }                                  // safe expression DSL
  | { type: 'function';   fn: (ctx: RuntimeContext) => boolean | Promise<boolean> };
```

**v1 ships:** `Phase` (the work-execution kind, used for every linear flow); `Fork` + `Join` (the splitter/aggregator pair for parallel paths). `Decision` ships in the type union but doesn't gate v1 acceptance — most pipelines won't need N-way conditional routing in v1; `requireApproval` on a `Phase` covers the most common branch (gate before continuing).

**Deferred to v1.x:** explicit `Loop` kind. LangGraph has no native loop primitive; v1's `Phase.retry: RetryPolicy` covers the common "retry until success" case. A general loop with arbitrary exit predicate is rare and lands as a non-breaking addition to the discriminated union when a real consumer needs it.

**Sub-pipelines** (formerly `kind: 'sub-pipeline'`) are now expressed as a `Phase` whose `agent: { ref: 'sub-pipeline:<id>' }` — keeps the FlowNode hierarchy at four kinds while preserving the capability.

**Splitter / Aggregator vocabulary.** `Fork` is the BPMN parallel-gateway / Camel Splitter / EIP "splitter" pattern; `Join` is the corresponding aggregator. Pipeline authors used to BPMN editors or workflow tools (n8n, Camunda, Apache Camel) will recognize both names. See § 14 glossary.

**Compile-time validation (in v1, runtime via Zod).** The catalog loader validates that:

- every `Fork.joinAt` references an existing `Join`
- every `Join.forkId` references the matching `Fork` (one-to-one pairing)
- every `next` / `branches` / `goto` reference resolves to a `FlowNode.id`
- the graph has exactly one entry node (designated by `Profile.start`)
- no cycles (other than v1.x `Loop` once it lands)

Validation errors throw `HarnessError { kind: 'config-error' }` at `harness.start()` — a broken catalog is never accepted into the runtime.

**Subagent worktrees ↔ Fork branches.** Each branch of a `Fork` is what the workspace-template PRD calls a "subagent" — the runtime allocates a dedicated worktree set per branch (`.harness/wt/<jobId>/<subagentId>/<repoName>/`) so parallel branches never collide on the filesystem. The mechanism (worktree path schema + branch naming) lives in workspace-template § 4.3.1; the policy (when to fan out, how many branches) lives here in the pipeline's `Fork` declaration. Two layers, one filesystem invariant.

### 6.7 `Pipeline`, `PipelineCatalog`, and `Coordinator`

```ts
interface Pipeline {
  description: string;
  whenToUse: string[];
  profiles: Record<string, Profile>;
  defaultProfile?: string;
}

interface Profile {
  flow:  FlowNode[];                  // graph of FlowNodes (Phase / Fork / Join / Decision); see § 6.6
  start: string;                      // id of the entry FlowNode (the first to execute)
}

interface PipelineCatalog {
  pipelines: Record<string, Pipeline>;
  defaultPipeline?: string;
}
```

Pipelines have no `kind` field — coordinator is a separate top-level concept.

```ts
interface Coordinator {
  agent: AgentSpec | { ref: string };
  outputSchema: ZodSchema<CoordinatorDecision>;
  tools?: string[];
  memory?: { read: boolean; write: boolean };
  contextProviders?: string[];
  onValidationFailure?: 'reject' | 'fallback';
  fallbackPipeline?: string;
  admissionPolicy?: AdmissionPolicy;
}

type CoordinatorDecision =
  | { accept: true; pipelineId: string; profile?: string; rationale: string }
  | { accept: false; rejectionReason: string; rationale: string };

type AdmissionPolicy = Policy<{ decision: CoordinatorDecision; input: AgentInput }, 'allow' | 'deny'>;

interface HarnessConfig {
  coordinator?: Coordinator;
  pipelines: Record<string, Pipeline>;
  defaultPipeline?: string;
  captureEnabled: boolean;
  budget?: BudgetConfig;
  retry?: RetryPolicy;
  pricing?: PriceTable;
}
```

### 6.8 `CredentialBroker`

```ts
interface CredentialBroker {
  resolve(sessionId: string, providerId: string): Promise<Credential>;
  refresh(sessionId: string, providerId: string): Promise<Credential>;
}

interface HarnessConfigurable {
  sessionId: string;
  credentialResolver: (providerId: string) => Promise<Credential>;
  captureEnabled: boolean;
  steeringInbox: SteeringInbox;
  tools?: HarnessTool[];
  pipeline?: string;
  profile?: string;
  signal: AbortSignal;
  logger: Logger;
}
```

### 6.9 `Provider`

```ts
interface Provider {
  id: string;
  authFlows: readonly AuthFlow[];
  refresh?(cred: Credential): Promise<Credential>;
}

type AuthFlow = 'api-key' | 'oauth-device' | 'oauth-redirect' | 'sigv4' | 'custom';
type Credential =
  | { type: 'api-key'; value: string }
  | { type: 'oauth'; accessToken: string; refreshToken?: string; expiresAt?: number }
  | { type: 'sigv4'; accessKeyId: string; secretAccessKey: string; sessionToken?: string; region: string }
  | { type: 'custom'; data: Record<string, unknown> };
```

### 6.10 Unified `Policy<TInput, TDecision>`

```ts
interface Policy<TInput, TDecision> {
  evaluate(ctx: RuntimeContext, input: TInput): TDecision | Promise<TDecision>;
}

type CredentialPolicy = Policy<{ providerId: string; phaseId: PhaseId }, 'allow' | 'deny'>;
type BudgetPolicy     = Policy<{ nextPhase: PhaseId },                    BudgetDecision>;
type EscalationPolicy = Policy<{ result: AgentInvocationResult },         EscalationDecision>;
```

### 6.11 HITL — escalation, steering, and the public `Harness` API

```ts
type EscalationDecision =
  | { action: 'continue' }
  | { action: 'warn'; message: string }
  | { action: 'escalate'; prompt: string; options?: HumanOption[]; blocking: true };

interface EscalationRequest {
  sessionId: string;
  pipelineId: string;
  phaseId: PhaseId;
  prompt: string;
  options?: HumanOption[];
  capturedContext: Pick<RuntimeContext, 'phaseOutputs' | 'capture'>;
  raisedAt: number;
}

interface SteeringMessage {
  id: string;
  receivedAt: number;
  scope: 'session' | 'phase';
  priority: 'urgent' | 'next-boundary';
  content: string;
  metadata?: Record<string, unknown>;
}

interface Harness {
  start(): Promise<void>;                                          // calls configStore.load() if wired

  // Single-shot execution
  run(input: AgentInput, opts: RunOptions): Promise<RunResult>;

  // Lifecycle control
  resume(sessionId: string, humanInput: HumanInput): Promise<RunResult>;
  cancel(sessionId: string, opts?: CancelOptions): Promise<RunResult>;
  rollback(sessionId: string, toPhase: PhaseId): Promise<void>;

  // Steering
  steer(sessionId: string, message: SteeringMessage): Promise<void>;
  getPending(sessionId: string): Promise<EscalationRequest | null>;

  // Observability
  events(sessionId: string): AsyncIterable<HarnessEvent>;
  onEvent(sessionId: string | '*', handler: (e: HarnessEvent) => void): () => void;

  // Cost preview
  estimateCost(input: AgentInput, pipelineId: string, profile: string,
               opts?: { detail: 'summary' | 'by-phase' }): Promise<CostEstimate>;

  // Pipeline catalog mutation
  savePipeline(id: string, pipeline: Pipeline): Promise<void>;
  deletePipeline(id: string): Promise<void>;
  listPipelines(): Promise<Array<{ id: string; pipeline: Pipeline }>>;

  onConfigChange?(handler: (event: ConfigChangeEvent) => void): () => void;
}

interface CancelOptions {
  reason?: string;
  graceful?: boolean;             // default true
  timeoutMs?: number;             // graceful drain timeout; default 30s
}

type RunResult =
  | { status: 'completed';   output: unknown; usage: UsageRollup; pipelineId: string; profile: string }
  | { status: 'interrupted'; pending: EscalationRequest }
  | { status: 'rejected';    reason: string; rationale?: string; usage: UsageRollup }
  | { status: 'cancelled';   reason: string; usage: UsageRollup; lastSnapshot?: SnapshotRef }
  | { status: 'errored';     error: HarnessError; usage: UsageRollup };
```

### 6.12 `SnapshotStrategy`

```ts
interface SnapshotStrategy {
  before(phaseId: PhaseId, ctx: RuntimeContext): Promise<SnapshotRef>;
  after(phaseId: PhaseId, ctx: RuntimeContext, result: AgentInvocationResult): Promise<SnapshotRef>;
  rollback(ref: SnapshotRef): Promise<void>;
  list(sessionId: string): Promise<SnapshotRef[]>;
}

interface SnapshotRef {
  id: string;
  strategy: string;
  phaseId: PhaseId;
  position: 'before' | 'after';
  checkpointId?: string;
  memorySnapshotId?: string;
  metadata?: Record<string, unknown>;
}
```

### 6.13 Storage interfaces (consumer-wired)

```ts
interface SessionStore {
  create(session: SessionMeta): Promise<void>;
  get(sessionId: string): Promise<SessionMeta | null>;
  update(sessionId: string, patch: Partial<SessionMeta>): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

interface CredentialStore {
  put(userId: string, providerId: string, cred: Credential): Promise<void>;
  get(userId: string, providerId: string): Promise<Credential | null>;
  delete(userId: string, providerId: string): Promise<void>;
}

interface CaptureSink {
  write(sessionId: string, phaseId: PhaseId, capture: AgentCapture): Promise<void>;
  read(sessionId: string, phaseId?: PhaseId): Promise<AgentCapture[]>;
}

interface ConfigStore {
  load(): Promise<HarnessConfig>;
  save(config: HarnessConfig): Promise<void>;
  savePipeline(id: string, pipeline: Pipeline): Promise<void>;
  deletePipeline(id: string): Promise<void>;
  saveProfile(pipelineId: string, profileId: string, profile: Profile): Promise<void>;
  onChange?(handler: (event: ConfigChangeEvent) => void): () => void;
}

interface ConfigChangeEvent {
  type: 'pipeline-added' | 'pipeline-modified' | 'pipeline-removed'
      | 'profile-modified' | 'whole-reload';
  pipelineId?: string;
  profileId?: string;
}
```

### 6.14 `HarnessTool`

```ts
interface HarnessTool {
  name: string;
  description: string;
  inputSchema: ZodSchema;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
  providerHints?: Record<string, unknown>;
}

interface ToolContext {
  sessionId: string;
  userId?: string;
  phaseId: PhaseId;
  pipelineId: string;
  memoryStore?: MemoryStore;
  contextProviders?: ContextProvider[];
  pipelineCatalog?: PipelineCatalog;
  logger: Logger;
}

type ToolResult = { ok: true; value: unknown } | { ok: false; error: ToolError };
```

### 6.15 `MemoryStore`

```ts
interface MemoryStore {
  put(scope: MemoryScope, key: string, value: MemoryEntry): Promise<void>;
  query(scope: MemoryScope, q: MemoryQuery): Promise<MemoryEntry[]>;
  forget(scope: MemoryScope, predicate: ForgetPredicate): Promise<number>;
  snapshot?(scope: MemoryScope): Promise<MemorySnapshot>;
  restore?(snapshot: MemorySnapshot): Promise<void>;
}

interface MemoryScope {
  userId?: string;
  sessionId?: string;
  organizationId?: string;
  topic?: string;
}

type MemoryQuery =
  | { type: 'similarity'; embedding: number[]; k: number }
  | { type: 'graph'; entity: string; depth: number; predicates?: string[] }
  | { type: 'structured'; filter: Record<string, unknown> }
  | { type: 'recent'; limit: number };
```

**Concurrency expectations**: when multiple jobs run concurrently in a workspace, the `MemoryStore` impl must handle concurrent writes safely. Recommended: transactional writes for session-scoped entries (rollback boundary) and last-write-wins or merge-by-vector-clock for user-scoped entries. The library does not enforce a model; the consumer's `MemoryStore` impl picks one and documents it.

### 6.16 `ContextProvider`

```ts
interface ContextProvider {
  id: string;
  capabilities: ContextProviderCapabilities;
  query(q: ContextQuery): Promise<ContextResult[]>;
  actions?: Record<string, ContextAction>;
}

interface ContextProviderCapabilities {
  queryTypes: ReadonlyArray<ContextQuery['type']>;
  providers: readonly string[];
  rateLimit?: { rpm?: number; concurrentMax?: number };
  cache?: { strategy: 'aggressive' | 'short-ttl' | 'none'; ttlSeconds?: number };
  fallback?: { onError: 'fail' | 'empty-result' | 'try-next' };
}

type ContextQuery =
  | { type: 'fulltext'; query: string; limit?: number }
  | { type: 'similarity'; embedding: number[]; k: number }
  | { type: 'structured'; filter: Record<string, unknown>; limit?: number }
  | { type: 'graph'; entity: string; depth: number };
```

### 6.17 `Plugin` contract

```ts
interface Plugin<TConfig = unknown> {
  readonly id: string;
  readonly position: 'pre' | 'post';
  execute(ctx: PluginContext): Promise<PluginResult>;
}

interface PluginContext {
  sessionId: string;
  pipelineId: string;
  phaseId: string;
  position: 'pre' | 'post';

  agentInput?: AgentInput;                     // pre only
  agentResult?: AgentInvocationResult;         // post only

  state: RuntimeStateProxy;                    // typed read/write proxy

  memoryStore?: MemoryStore;
  contextProviders?: ContextProvider[];

  logger: Logger;                              // child-bound to { pipelineId, phaseId, pluginId }
  signal: AbortSignal;
}

interface RuntimeStateProxy {
  readPhaseOutput(phaseId: string): unknown;
  writeOwnOutput(value: unknown): void;        // post only — sets current phase output
  readScratch<T = unknown>(key: string): T | undefined;
  writeScratch(key: string, value: unknown): void;   // namespaced under plugin.id
  readSteering(): SteeringMessage[];
  readUsage(): UsageRollup;
}

type PluginResult =
  | { ok: true }
  | { ok: true; transformInput: AgentInput }                                       // pre only
  | { ok: true; skipPhase: true; reason: string; phaseOutput?: unknown }           // pre only
  | { ok: false; error: PluginError; behavior: 'fail-phase' | 'continue' };

interface PluginFactory<TConfig = unknown> {
  readonly id: string;
  readonly position: 'pre' | 'post';
  readonly schema: ZodSchema<TConfig>;
  create(config: TConfig, deps: PluginDeps): Plugin<TConfig>;
}

interface PluginDeps {
  logger: Logger;
}
```

**Ordering**: declared array order, no auto-reordering. **Failure behavior**: per-invocation `behavior` field — `'fail-phase'` (default) or `'continue'`.

### 6.18 `HarnessError` taxonomy and `RetryPolicy`

```ts
type HarnessError =
  | { kind: 'transient';              cause: unknown; message: string; retriable: true }
  | { kind: 'rate-limit';             provider: string; retryAfterMs?: number; retriable: true }
  | { kind: 'authentication';         provider: string; message: string; retriable: false }
  | { kind: 'authorization';          providerId: string; phaseId: string; retriable: false }
  | { kind: 'validation';             field: string; message: string; retriable: false }
  | { kind: 'capacity';               resource: string; message: string; retriable: 'eventually' }
  | { kind: 'tool-error';             toolName: string; cause: unknown; retriable: boolean }
  | { kind: 'plugin-error';           pluginId: string; cause: unknown; retriable: boolean }
  | { kind: 'context-provider-error'; providerId: string; cause: unknown; retriable: boolean }
  | { kind: 'cancelled';              reason: string; retriable: false }
  | { kind: 'escalation-rejected';    phaseId: string; retriable: false }
  | { kind: 'config-error';           message: string; retriable: false }
  | { kind: 'terminal';               cause: unknown; message: string; retriable: false };

interface RetryPolicy {
  maxAttempts: number;                                             // default 3
  initialDelayMs: number;                                          // default 1000
  maxDelayMs: number;                                              // default 30000
  backoff: 'fixed' | 'exponential' | 'exponential-jittered';       // default 'exponential-jittered'
  retryableErrorKinds?: readonly HarnessError['kind'][];
  retryable?: (error: HarnessError, attempt: number) => boolean;
  onMaxAttempts?: 'fail-phase' | 'escalate' | 'fail-session';      // default 'fail-phase'
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  backoff: 'exponential-jittered',
  onMaxAttempts: 'fail-phase',
};
```

Default retry behavior: kinds with `retriable: true` retry; `retriable: false` skip; `retriable: 'eventually'` retries once after a longer cooldown.

### 6.19 `Logger`

```ts
interface Logger {
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, error?: Error | LogFields, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

type LogFields = Record<string, unknown>;
```

Built-in impls: `noopLogger`, `consoleLogger({ level })`. Adapter packages: `pinoAdapter`, `winstonAdapter`. Each phase's logger is `child({ sessionId, pipelineId, phaseId })`-bound.

### 6.20 `TracingProvider`

```ts
interface TracingProvider {
  readonly id: string;                                    // 'noop' | 'langsmith' | 'otel' | custom

  startSession(sessionId: string, metadata: TracingSessionMetadata): TracingHandle;
  startPhase(parent: TracingHandle, phaseId: string, agentSpec: AgentSpec): TracingHandle;
  recordAdapterInvocation(handle: TracingHandle, result: AgentInvocationResult): void;
  recordToolCall(handle: TracingHandle, toolName: string, args: unknown, result: ToolResult): void;
  recordPlugin(handle: TracingHandle, position: 'pre' | 'post', pluginId: string, result: PluginResult): void;
  endPhase(handle: TracingHandle, error?: HarnessError): void;
  endSession(handle: TracingHandle, result: RunResult): void;
}

interface TracingHandle {
  readonly id: string;            // implementation-defined trace/run/span id (LangSmith run id, OTel trace id, etc.)
  readonly url?: string;          // optional deep-link URL for surfacing in TUI / VS Code / harness-server REST API
}

interface TracingSessionMetadata {
  pipelineId: string;
  profile: string;
  workspace?: string;
  tenant?: { userId?: string; orgId?: string };
  tags?: string[];
}
```

The orchestrator wires the provider at session start; every adapter invocation, plugin run, and tool call automatically generates trace data without each subsystem knowing about LangSmith / OTel specifically. The `TracingHandle.url` field is the deep-link path — when populated, the harness-server's REST API includes it in `GET /v1/jobs/{id}` so TUI and VS Code can open the trace directly in the LangSmith UI (or any backend that exposes per-run URLs).

Built-in impl: `noopTracingProvider` (default — zero overhead, nothing emitted; satisfies the type without any external dependency). Companion packages:

- **`tracing-langsmith`** — wraps the LangSmith SDK; pulls API key from `CredentialBroker.getCredential('langsmith')`; one LangSmith run per session, one nested run per phase. `TracingHandle.url` returns the LangSmith deep-link.
- **`tracing-otel`** — vendor-neutral OpenTelemetry spans with GenAI semantic conventions (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, etc.). Works with any OTel collector — Tempo, Jaeger, Datadog, Honeycomb, or self-hosted LangSmith via OTel ingestion (`LANGSMITH_OTEL_ENABLED=true`). Preferred for restricted environments where SaaS LangSmith isn't acceptable.

Hosts that don't want tracing pass `noopTracingProvider`; hosts in restricted environments swap to `tracing-otel` pointing at a self-hosted backend.

### 6.21 `HarnessEvent` — progress event stream

```ts
type HarnessEvent =
  // Lifecycle
  | { type: 'session-started';       sessionId: string; pipelineId: string; profile: string; ts: number }
  | { type: 'session-completed';     sessionId: string; result: RunResult; ts: number }
  | { type: 'session-cancelled';     sessionId: string; reason: string; ts: number }
  | { type: 'session-rejected';      sessionId: string; reason: string; ts: number }

  // Coordinator
  | { type: 'coordinator-decided';   sessionId: string; decision: CoordinatorDecision; ts: number }

  // Phase
  | { type: 'phase-started';         sessionId: string; phaseId: string; agent: { type: string; model?: string }; ts: number }
  | { type: 'phase-completed';       sessionId: string; phaseId: string; usage: TokenUsage; durationMs: number; ts: number }
  | { type: 'phase-failed';          sessionId: string; phaseId: string; error: HarnessError; willRetry: boolean; ts: number }

  // Plugin
  | { type: 'plugin-started';        sessionId: string; phaseId: string; pluginId: string; position: 'pre' | 'post'; ts: number }
  | { type: 'plugin-completed';      sessionId: string; phaseId: string; pluginId: string; ts: number }

  // Streaming
  | { type: 'thinking-chunk';        sessionId: string; phaseId: string; chunk: string; ts: number }
  | { type: 'output-chunk';          sessionId: string; phaseId: string; chunk: string; ts: number }

  // Tool
  | { type: 'tool-called';           sessionId: string; phaseId: string; toolName: string; args: unknown; ts: number }
  | { type: 'tool-completed';        sessionId: string; phaseId: string; toolName: string; durationMs: number; ts: number }
  | { type: 'tool-failed';           sessionId: string; phaseId: string; toolName: string; error: HarnessError; ts: number }

  // State
  | { type: 'snapshot-taken';        sessionId: string; phaseId: string; ref: SnapshotRef; ts: number }
  | { type: 'rollback-completed';    sessionId: string; toPhase: string; ts: number }
  | { type: 'escalation-raised';     sessionId: string; request: EscalationRequest; ts: number }
  | { type: 'steering-received';     sessionId: string; messageId: string; ts: number };
```

In-process pubsub by default. For multi-process / central-server topologies, wire an `EventBus` adapter (consumer-supplied, post-v1 interface).

### 6.22 `CostEstimate`

```ts
interface CostEstimate {
  expectedTokens: {
    input: { min: number; max: number; expected: number };
    output: { min: number; max: number; expected: number };
    reasoning?: { min: number; max: number; expected: number };
  };
  expectedDollars: { min: number; max: number; expected: number; currency: string };
  byPhase?: Record<string, CostEstimate>;
  basis: 'historical-mean' | 'historical-median' | 'static-heuristic';
  confidence: 'low' | 'medium' | 'high';
  warnings?: string[];
}

interface PriceTable {
  [providerColonModel: string]: { inputPerM: number; outputPerM: number; cacheReadPerM?: number; reasoningPerM?: number };
}
```

v1: static-heuristic basis using `agent.maxTokens`, `reasoningEffort` thresholds, declared tools, and tokenizer-pass over input. v2: historical mode reads MemoryStore for prior similar-input runs.

### 6.23 Multi-job runtime: `Job`, `JobQueue`, `Workspace`, `WorktreeManager`, `JobSource`, `JobSink`

This subsystem ships in the optional `agentic-harness-runtime` companion package. The library does not depend on it.

```ts
interface Job {
  id: string;
  idempotencyKey?: string;
  input: AgentInput;
  pipeline?: string;                       // 'auto' | explicit pipeline id | undefined → coordinator
  profile?: string;
  priority?: number;                       // default 0; higher runs sooner
  scheduledAt?: number;                    // future scheduling
  deadline?: number;                       // soft deadline
  source?: string;                         // 'cli', 'github:issue', 'linear:ticket', ...
  sourceMetadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface JobLifecycle {
  jobId: string;
  status: 'pending' | 'running' | 'paused-escalation' | 'completed' | 'failed' | 'cancelled' | 'rejected';
  submittedAt: number;
  startedAt?: number;
  completedAt?: number;
  attempts: number;
  sessionId?: string;                      // populated once running
  result?: RunResult;
  lastError?: HarnessError;
}

interface JobQueue {
  enqueue(job: Job): Promise<JobLifecycle>;
  next(workerId: string): Promise<Job | null>;            // visibility-locked to worker
  ack(jobId: string, result: RunResult): Promise<void>;
  nack(jobId: string, error: HarnessError, willRetry: boolean): Promise<void>;
  status(jobId: string): Promise<JobLifecycle>;
  list(filter?: JobFilter): Promise<JobLifecycle[]>;
  cancel(jobId: string, reason: string): Promise<void>;
  onChange?(handler: (event: JobQueueEvent) => void): () => void;
}

interface JobFilter {
  status?: JobLifecycle['status'][];
  pipeline?: string;
  source?: string;
  submittedAfter?: number;
  limit?: number;
}

interface Workspace {
  id: string;
  rootDir: string;
  jobQueue: JobQueue;
  worktreeManager: WorktreeManager;
  concurrency: ConcurrencyConfig;
  jobSources: JobSource[];
  jobSinks: JobSink[];
  hooks?: WorkspaceHooks;

  // Public API
  submit(jobInput: Omit<Job, 'id'>): Promise<JobLifecycle>;
  status(jobId: string): Promise<JobLifecycle>;
  listJobs(filter?: JobFilter): Promise<JobLifecycle[]>;
  cancel(jobId: string, reason: string): Promise<void>;
  run(opts: { mode: 'drain' | 'watch' | 'autonomous' }): Promise<void>;
  drain(timeoutMs?: number): Promise<void>;
  onEvent(handler: (event: WorkspaceEvent) => void): () => void;
}

interface WorktreeManager {
  acquire(jobId: string, baseRef: string): Promise<WorkTree>;
  release(jobId: string, opts?: { keep?: boolean }): Promise<void>;
  list(): Promise<WorkTree[]>;
  prune(olderThanMs: number): Promise<number>;
}

interface WorkTree {
  jobId: string;
  path: string;
  baseRef: string;
  branch: string;
  createdAt: number;
}

interface ConcurrencyConfig {
  maxConcurrentJobs: number;
  maxConcurrentPerPipeline?: Record<string, number>;
  maxConcurrentPerProvider?: Record<string, number>;
  jobTimeoutMs?: number;
  drainGracePeriodMs?: number;
}

interface JobSource {
  id: string;
  start(submit: (j: Omit<Job, 'id'>) => Promise<JobLifecycle>): Promise<void>;
  stop(): Promise<void>;
}

interface JobSink {
  id: string;
  match(job: Job, result: RunResult): boolean;
  deliver(job: Job, result: RunResult): Promise<void>;
}

interface WorkspaceHooks {
  onJobAcquired?(job: Job, worktree: WorkTree): Promise<void>;
  onJobCompleted?(job: Job, result: RunResult): Promise<void>;
  onJobFailed?(job: Job, error: HarnessError): Promise<void>;
  onWorkspaceDrain?(): Promise<void>;
}
```

**The central-server pattern is a deployment of the above interfaces**: `RemoteJobQueue` (HTTP/WebSocket → server), `RemoteConfigStore`, `WebhookSink` pointing at the server, `pinoAdapter` configured with a network transport. No new interfaces required.

## 7. Configuration layering

```
┌─────────────────────────────────────────────────────────┐
│ BUILD TIME (TS code, in your bundle)                    │
│  createHarness({ adapters, plugins, providers, … })     │
└─────────────────────────────────────────────────────────┘
                  │
                  ▼ harness.start() calls configStore.load()
┌─────────────────────────────────────────────────────────┐
│ DURABLE CONFIG (loaded from ConfigStore at startup)     │
│  HarnessConfig {                                        │
│    coordinator?: { ... }                                │
│    pipelines: { ... }                                   │
│    captureEnabled, budget, retry, pricing, ...          │
│  }                                                      │
└─────────────────────────────────────────────────────────┘
                  │
                  ▼ runtime additions persist via savePipeline()
┌─────────────────────────────────────────────────────────┐
│ RUNTIME PERSISTENCE                                     │
└─────────────────────────────────────────────────────────┘
                  │
                  ▼ session start
┌─────────────────────────────────────────────────────────┐
│ PER-SESSION (RunnableConfig.configurable)               │
│  pipeline, profile, phaseOverrides, captureEnabled, …   │
└─────────────────────────────────────────────────────────┘
                  │
                  ▼ workspace runtime (separate package, optional)
┌─────────────────────────────────────────────────────────┐
│ WORKSPACE CONFIG (createWorkspace({...}))               │
│  Concurrency, sources, sinks, worktreeManager, hooks    │
│  Sits OUTSIDE HarnessConfig — runtime-layer concern     │
└─────────────────────────────────────────────────────────┘
```

Merge precedence (lowest → highest): build-time defaults < durable config < runtime additions < selected pipeline + profile < per-session overrides.

## 8. Lifecycle flows

### 8.0 Coordinator dispatch (single-shot agent invocation)

```
harness.run(input, { configurable: { pipeline: 'auto' } })
   ──► if pipeline === 'auto' AND coordinator is configured:
        invoke coordinator.agent (single agent call)
   ──► validate output against coordinator.outputSchema
        on validation failure → onValidationFailure: 'reject' | 'fallback'
   ──► inspect decision.accept:
        false → return RunResult { status: 'rejected', ... }
        true  → run admissionPolicy (if any); if 'allow' dispatch
   ──► explicit pipeline id: skip coordinator
   ──► no coordinator + no explicit pipeline + no defaultPipeline: error
```

### 8.1 Happy path

```
run(input) ──► resolve pipeline + profile (with coordinator dispatch)
              apply per-session overrides
              create session ──► enter graph for resolved pipeline
   for each phaseNode in resolved profile:
     compile to LangGraph nodes per kind (sequence / parallel / etc.)
     for each phase:
       snapshot.before()
       run pre-plugins (enrich)
       adapter.invoke(...)  ← exposes tools (memory, context, etc.) to LLM
       merge result.usage into ctx.usage
       capture if enabled
       run post-plugins (consolidate)
       escalation.evaluate → continue / warn / escalate
       snapshot.after()
   return RunResult
```

### 8.2 Escalation

```
EscalationPolicy returns 'escalate'
   → snapshot.after() (capture state)
   → persist EscalationRequest in SessionStore
   → checkpointer interrupt
   → return RunResult { status: 'interrupted' }

harness.resume(sessionId, humanInput)
   → load checkpoint, merge humanInput, graph resumes
```

### 8.3 Steering

```
harness.steer(sessionId, message) → append to ctx.steering[]; persist via checkpointer
phase boundary picks up matching messages
priority='urgent' + supportsCancellation → mid-phase abort + re-enter with steering
```

### 8.4 Rollback (three-way coordination)

```
harness.rollback(sessionId, toPhase)
   1. PREPARE: verify checkpointId, snapshotRef, memorySnapshotId resolvable
   2. COMMIT: snapshotStrategy.rollback() + checkpointer.restore() + memoryStore.restore()
   3. on failure: best-effort revert
   excludes: user-/org-scoped memory writes, ContextProvider calls, CaptureSink, pipeline catalog
```

### 8.5 Runtime pipeline persistence

```
harness.savePipeline(id, pipeline)
   → validate against build-time registries
   → configStore.savePipeline()
   → fire ConfigChangeEvent
   → running sessions snapshot config; new sessions see additions
```

### 8.6 Cancellation

```
harness.cancel(sessionId, { graceful: true, timeoutMs: 30000 })
   → abort signal flows through RunnableConfig.configurable.signal
   → adapters with supportsCancellation exit cleanly
   → adapters without it → force-killed after timeout
   → snapshot.after() captures point-of-cancel state
   → returns RunResult { status: 'cancelled', reason, lastSnapshot }
   consumer may follow up with rollback() to undo, or accept partial state
```

### 8.7 Worker loop (autonomous mode, in `agentic-harness-runtime`)

```
worker(workerId, workspace):
  while not draining:
    job = await jobQueue.next(workerId)              // visibility-locked
    if no job: sleep(pollInterval); continue

    if pipeline declares requiresWorktree:
      worktree = await worktreeManager.acquire(job.id, 'main')
      // adapter filesystem operations target worktree.path

    sessionId = generate
    update lifecycle: status='running', sessionId, startedAt
    emit JobQueueEvent { type: 'job-started', ... }

    result = await harness.run(job.input, {
      sessionId,
      configurable: { pipeline: job.pipeline ?? 'auto', profile: job.profile,
                      ...workspace-injected (logger, signal) }
    })

    on completion / rejection:
      jobQueue.ack(job.id, result)
      for each matching jobSink: sink.deliver(job, result)
      worktreeManager.release(job.id, { keep: result.status === 'completed' && pipelineMutatedFs })

    on failure:
      jobQueue.nack(job.id, error, willRetry)
      hooks.onJobFailed?.(job, error)
      worktreeManager.release(job.id)

    on cancel signal:
      drain in-flight; release worktrees; exit
```

## 9. Open decisions

### Q1 — `CredentialBroker.resolve()` return type
A. Raw / B. Pre-built clients / C. Hybrid. **Lean:** C. **Resolution:** TODO

### Q2 — Credential scoping policy
A. Implicit / B. Explicit per-component (least-privilege) / C. Policy function. **Lean:** B + C as fallback. **Resolution:** TODO

### Q4 — Budget enforcement
A. Tracking only / B. Ship `BudgetGate` plugin opt-in / C. Always-on. **Lean:** B. **Resolution:** TODO

### Q5 — Capture storage and redaction default
**Storage:** A. Same store / B. Separate `CaptureSink`. **Lean:** B.
**Redaction:** A. Deny-list / B. Allow-list. **Lean:** A for headers/credentials; B for content fields. **Resolution:** TODO

### Q6 — Streaming usage shape
A. Final synthetic chunk / B. Separate completion handle / C. Callback on context. **Lean:** A. **Resolution:** TODO

### Q7 — Provider config normalization
A. Pure pass-through / B. Normalized verbs + native escape / C. Full normalization. **Lean:** B with the verb mapping in § 6.3. **Resolution:** TODO

### Q8 — Phase set dynamism
A. Static / B. Fully dynamic / C. Hybrid (declared catalog, runtime picks order/enabled/adapter). **Lean:** C. **Resolution:** TODO

### Q9 — Phase independence: state-sharing model
A. Typed handoffs only / B. Hybrid (typed + scratch) / C. Shared blackboard. **Lean:** B. **Resolution:** TODO

### Q10 — Steering urgency model
A. Boundary-only / B. Opt-in urgent (default boundary) / C. Always-interrupt. **Lean:** B. **Resolution:** TODO

### Q11 — Snapshot strategy package layout
A. In core / B. Interface in core, impls in packages / C. Pure plugin. **Lean:** B. **Resolution:** TODO

### Q12 — Three-way rollback coordination
A. Linked refs sequential / B. Three-way two-phase commit / C. Single source of truth. **Lean:** B. **Resolution:** TODO

### Q13 — Knowledge subsystems: split or unified?
A. Single unified / B. Separate `MemoryStore` and `ContextProvider` feeding `HarnessTool` / C. No core interfaces. **Lean:** B. **Resolution:** TODO

### Q14 — Profiles: first-class, convention, or out of scope?
A. First-class / B. Convention only / C. Out of scope. **Lean:** A. **Resolution:** TODO

### Q15 — Adaptive planning (router phase) for v1?
A. In v1 / B. Out of v1, design-compatible / C. Out of scope. **Lean:** B. **Resolution:** TODO

### Q16 — Tool/skill as first-class in adapter contract?
A. First-class `HarnessTool` / B. Adapter-specific / C. Full MCP server. **Lean:** A. **Resolution:** TODO

### Q17 — CLI packaging
A. One CLI with subcommands / B. Multiple separate CLIs / C. Skip CLIs. **Lean:** A. **Resolution:** TODO

### Q18 — MCP integration depth
A. None in v1 / B. Built-in `McpClientProvider` (client only) / C. Full MCP server + client. **Lean:** B. **Resolution:** TODO

### Q19 — Per-phase access: separate fields for memory and context?
A. Single `knowledgeSources` allowlist / B. Separate `memory:{read,write}` + `contextProviders[]` + `tools[]`. **Lean:** B. **Resolution:** TODO

### Q20 — Pipeline catalog: built-in concept or convention?
A. First-class / B. Convention / C. Hybrid (single phases or pipelines map). **Lean:** C. **Resolution:** TODO

### Q21 — Coordinator shape: agent or pipeline?
A. Coordinator-as-pipeline / B. Coordinator-as-agent (top-level peer) / C. Both. **Lean:** B. **Resolution:** TODO

### Q22 — Pipeline synthesis (coordinator emits new pipelines): v1 or v2?
A. v1 with full validation / B. v2 / C. Out of scope. **Lean:** B. **Resolution:** TODO

### Q23 — Config persistence: `ConfigStore` first-class?
A. First-class / B. Convention only / C. Hybrid (optional). **Lean:** C. **Resolution:** TODO

### Q24 — Synthesized pipelines: persistence default
A. Ephemeral / B. Always persisted / C. Per-coordinator config. **Lean:** A. **Resolution:** TODO

### Q25 — Admission control: agent-only or layered policy?
A. Agent-only / B. Layered (agent + `AdmissionPolicy`) / C. Policy-only. **Lean:** B. **Resolution:** TODO

### Q26 — Runtime layer: separate package or in-core?
A. Separate `agentic-harness-runtime` package / B. In-core / C. Interface-only in core, impls separate. **Lean:** A or C. **Resolution:** TODO

### Q27 — Worker model: in-process pool, multi-process, external?
A. In-process pool / B. Multi-process / C. External (BullMQ-style). **Lean:** A for v1. **Resolution:** TODO

### Q28 — Worktree default: always-on or pipeline-declared?
A. Always-on for autonomous-mode / B. Per-pipeline `requiresWorktree: boolean` / C. Auto-detect. **Lean:** B. **Resolution:** TODO

### Q29 — Job idempotency strategy
A. Idempotency key + dedup window / B. Content-hash auto-dedup / C. Caller-provided only. **Lean:** C with optional content-hash mode. **Resolution:** TODO

### Q30 — Failure recovery: retry whole job or resume from snapshot?
A. Whole-job retry / B. Resume-from-snapshot / C. Per-pipeline declaration. **Lean:** B for code-mutating, A for short, with C as override. **Resolution:** TODO

### Q31 — Central-server / control-plane pattern: ship adapters, document only, or out of scope?
A. Ship `agentic-harness-control-plane-client` adapter package / B. Document the pattern; no shipped adapters / C. Out of scope. **Lean:** B — same pattern as Datadog/Sentry SDK; the central server is a consumer/community deployment, not a library concern. **Resolution:** TODO

## 10. Reference consumers

### 10.1 Library-only single-shot consumer

```ts
import { createHarness } from '@your-org/agentic-harness';
import { claudeSdkAdapter, openCodeAdapter, openAiAdapter,
         anthropicProvider, githubProvider as githubAuthProvider, atlassianProvider,
         mcpClientProvider } from '@your-org/agentic-harness';
import { gitCommitSnapshot } from '@your-org/agentic-harness-git-snapshot';
import { GraphMemoryStore } from '@your-org/agentic-harness-memory-neo4j';
import { githubRepoProvider } from '@your-org/agentic-harness-context-github';
import { confluenceProvider } from '@your-org/agentic-harness-context-confluence';
import { openApiProvider } from '@your-org/agentic-harness-context-openapi';
import { FsConfigStore } from '@your-org/agentic-harness-config-fs';
import { pinoAdapter } from '@your-org/agentic-harness-logger-pino';

import { FsCredentialStore } from './my-credential-store';
import { FsSessionStore } from './my-session-store';
import { S3CaptureSink } from './my-capture-sink';

const harness = createHarness({
  adapters: [claudeSdkAdapter, openCodeAdapter, openAiAdapter],
  providers: [anthropicProvider, githubAuthProvider, atlassianProvider],
  snapshotStrategies: [gitCommitSnapshot],
  memoryStore: new GraphMemoryStore({ uri: process.env.NEO4J_URI! }),
  contextProviders: [
    githubRepoProvider({ repo: 'skoolscout/jefelabs-com' }),
    confluenceProvider({ space: 'eng' }),
    openApiProvider({ specUrl: 'https://api.stripe.com/v1/openapi.json' }),
    mcpClientProvider({ id: 'mcp:context7', server: 'https://mcp.context7.com' }),
  ],
  configStore: new FsConfigStore({ path: '~/.myapp/config' }),
  sessionStore: new FsSessionStore('~/.myapp/sessions'),
  credentialStore: new FsCredentialStore('~/.myapp/credentials'),
  captureSink: new S3CaptureSink({ bucket: 'my-traces' }),
  checkpointer: new SqliteSaver({ path: '~/.myapp/checkpoints.db' }),
  logger: pinoAdapter(pino()),
  pricing: defaultPriceTable,                 // override or extend the shipped table
});

await harness.start();

// Subscribe to events for a UI
const unsubscribe = harness.onEvent('*', (e) => {
  if (e.type === 'phase-started') updateUI(`▶ ${e.phaseId}`);
  if (e.type === 'thinking-chunk') appendThinking(e.chunk);
  if (e.type === 'output-chunk') appendOutput(e.chunk);
});

// Pre-flight cost preview
const estimate = await harness.estimateCost(
  { task: 'Add dark mode toggle to settings' },
  'brownfield-ui-enhancement', 'standard',
);
if (estimate.expectedDollars.expected > 5) {
  if (!await confirmWithUser(estimate)) return;
}

// Single-shot run
const result = await harness.run(
  { task: 'Upgrade dashboard package from Vue 2.7 to Vue 3.5' },
  { sessionId: 'sess-abc-123', configurable: { pipeline: 'auto' } }
);

switch (result.status) {
  case 'completed':   return result.output;
  case 'interrupted': return harness.resume('sess-abc-123', await getHumanInput(result.pending));
  case 'rejected':    return notifyUser('Not actionable', result.reason);
  case 'cancelled':   return notifyUser('Cancelled', result.reason);
  case 'errored':     return handleError(result.error);
}
```

### 10.2 Autonomous workspace consumer

```ts
import { createWorkspace } from '@your-org/agentic-harness-runtime';
import { RedisJobQueue } from '@your-org/agentic-harness-jobqueue-redis';
import { GitWorktreeManager } from '@your-org/agentic-harness-git-snapshot';
import { GitHubIssueSource } from '@your-org/agentic-harness-source-github';
import { CronSource } from '@your-org/agentic-harness-source-cron';
import { GitHubPrSink, GitHubIssueCommentSink } from '@your-org/agentic-harness-sink-github';
import { SlackChannelSink } from '@your-org/agentic-harness-sink-slack';

// Reuse the same harness instance from 10.1
const workspace = createWorkspace({
  id: 'autonomous-prod',
  rootDir: '/var/agent-workspace/my-repo',
  jobQueue: new RedisJobQueue({ url: process.env.REDIS_URL! }),
  worktreeManager: new GitWorktreeManager({ baseRepo: '/var/agent-workspace/my-repo' }),
  concurrency: {
    maxConcurrentJobs: 4,
    maxConcurrentPerProvider: { anthropic: 6 },
    jobTimeoutMs: 30 * 60 * 1000,
    drainGracePeriodMs: 60 * 1000,
  },
  jobSources: [
    new GitHubIssueSource({
      repo: 'org/repo',
      labels: ['agent-handle'],
      pollIntervalMs: 30_000,
    }),
    new CronSource([
      { schedule: '0 2 * * MON', pipeline: 'backend-techstack-upgrade', input: { check: true } },
    ]),
  ],
  jobSinks: [
    new GitHubPrSink({ baseRef: 'main' }),
    new GitHubIssueCommentSink(),
    new SlackChannelSink({ channel: '#agent-activity' }),
  ],
  hooks: {
    onJobFailed: async (job, error) => metrics.increment('job.failed', { kind: error.kind }),
  },
  harness,
});

// Drains forever; SIGTERM triggers graceful drain
await workspace.run({ mode: 'autonomous' });
```

### 10.3 CLI surface

```
$ harness memory query --scope user:alice --type graph --entity 'authentication' --depth 2
$ harness context github search --repo skoolscout/jefelabs-com --query 'auth middleware'
$ harness pipeline list
$ harness pipeline run prd-greenfield --profile standard --input ./brief.json
$ harness pipeline run frontend-techstack-upgrade --profile standard --input ./task.json
$ harness rollback --session abc-123 --to-phase implement
$ harness job submit --pipeline=auto --input=./task1.json
$ harness job list --status=failed
$ harness workspace drain --timeout=300
```

## 11. Out of scope (explicitly)

- Prompt management/versioning
- Model fallback / routing by cost or latency
- Adaptive planning (router phase) inside a pipeline
- Pipeline synthesis (v2)
- Full MCP server compliance (post-v1)
- In-flight config hot-reload (only new sessions/jobs pick up changes)
- Per-phase capture override (global toggle in v1)
- Multi-tenancy primitives beyond session/scope isolation
- Rich UI for HITL (consumer renders)
- Multi-process workers (post-v1)
- External worker systems (Temporal etc.) integration (post-v1)
- Tool implementations beyond memory/escalation/pipeline-ops (consumer concern)
- Quota/billing systems (consumer concern)
- A central-server product (consumer/community concern via adapters)

## 12. Versioning and stability

- **Semantic versioning** with the public API surface defined as everything exported from `src/index.ts`.
- **Build-time interfaces** (factories, schemas) are stable; breaking changes are major versions.
- **Adapter implementations** ship in core initially; each is independently deprecable.
- **Companion packages** (context providers, ConfigStore impls, JobQueue impls, sources, sinks, runtime, CLI, logger adapters) are independently versioned.
- **`FlowNode`** (Phase / Fork / Join / Decision) is a discriminated union; new variants — including v1.x `Loop` — are non-breaking additions.
- **`HarnessEvent`** is a discriminated union; new event types are non-breaking.
- **`HarnessError`** is a discriminated union; new kinds are non-breaking.
- Pre-1.0: no stability guarantee; expect churn while Q1–Q31 settle.

## 13. Implementation milestones

After resolving Q1–Q31:

1. **M1 — Interfaces** (1–2 days): all type definitions; CI passes typecheck.
2. **M2 — Core orchestration** (3–5 days): LangGraph wiring, sequence-only phase execution, plugin registry, validation, profile + pipeline merge. Memory impls for tests.
3. **M3 — First adapter end-to-end** (2–3 days): Claude SDK adapter with full normalized verbs, usage reporting, real Anthropic key fixture.
4. **M4 — Credential broker + Anthropic provider** (2 days): full auth flow, refresh, scoping policy.
5. **M5 — `HarnessTool` registry + memory tools** (2 days): tool registration, memory.* built-ins, per-phase grants enforcement.
6. **M6 — HITL + steering** (3 days): escalation policies, `interrupt`/`resume`, steering inbox, urgent cancellation path.
7. **M7 — Snapshot strategy + git impl + three-way rollback** (3 days): two-phase three-way coordination.
8. **M8 — `ContextProvider` framework + `McpClientProvider`** (3 days): subsystem 2 plumbing; first concrete provider via MCP bridge.
9. **M9 — OpenCode CLI adapter** (2 days): wraps the CLI, parses usage, falls back to estimation.
10. **M10 — One concrete context provider** (2 days): GitHub repo provider as reference.
11. **M11 — Pipeline catalog + coordinator dispatch** (3 days): admission control + routing.
12. **M12 — `ConfigStore` + `FsConfigStore` impl** (2 days): durable config + savePipeline + onChange.
13. **M13 — Logger + error taxonomy + retry** (2 days): structured logging, `HarnessError`, `RetryPolicy` defaults.
14. **M14 — Progress events + cancellation API** (2 days): `harness.events()`, `harness.cancel()`, full event coverage.
15. **M15 — Cost estimation (static-heuristic)** (1–2 days): `harness.estimateCost()` with shipped price table.
16. **M16 — `FlowNode` Fork + Join composition** (2–3 days): `Fork` splitter + `Join` aggregator with `ParallelMergeStrategy`; subagent worktree allocation per Fork branch (see workspace-template § 4.3.1). `Decision` ships in the type union but is not gating. `Loop` is post-v1.
17. **M17 — `agentic-harness-runtime` package** (3–4 days): `Workspace`, `JobQueue`, worker loop, in-memory + sqlite job queue impls, `WorktreeManager`, basic source/sink.
18. **M18 — One concrete source + one concrete sink** (2 days): `GitHubIssueSource`, `GitHubPrSink` as references.
19. **M19 — CLI surface** (2 days): unified CLI in companion package; subcommands for memory, context, rollback, pipeline, job ops.
20. **M20 — Reference consumers + docs** (2 days): library-only and autonomous-workspace examples, end-to-end with the five reference pipelines.

## 14. Glossary

| Term | Meaning |
|------|---------|
| **Adapter** | Backend-specific implementation of `AgentAdapter`. |
| **Phase** | One agent invocation surrounded by enrich/work/consolidate, snapshot, escalation. |
| **FlowNode** | A discriminated union element in `Profile.flow`: **Phase** (work-execution) / **Fork** (splitter) / **Join** (aggregator) / **Decision** (conditional routing). v1.x adds `Loop`. See § 6.6. |
| **Phase** | The FlowNode kind that does the actual work (agent invocation surrounded by enrich / consolidate / snapshot / escalation). Carries every former `PhaseConfig` field. |
| **Fork** | The FlowNode kind that creates parallel paths. Equivalent to BPMN's parallel gateway, Apache Camel's Splitter, or the EIP "splitter" pattern. Each branch gets its own subagent worktree set (see workspace-template § 4.3.1). |
| **Join** | The FlowNode kind that synchronizes parallel paths back to one. Equivalent to BPMN's parallel-join or the EIP "aggregator" pattern. Configures a `ParallelMergeStrategy`. |
| **Decision** | The FlowNode kind that routes to one of N downstream paths based on predicates. Optional in v1. |
| **Splitter** | Synonym for `Fork` — BPMN / EIP vocabulary. |
| **Aggregator** | Synonym for `Join` — BPMN / EIP vocabulary. |
| **Plugin** | A pre- or post-phase hook that reads/mutates `RuntimeContext` via a typed proxy. |
| **Profile** | Named bundle of phase configuration tuning level-of-effort knobs. |
| **Pipeline** | Named bundle targeting a specific job class. |
| **PipelineCatalog** | The `Record<string, Pipeline>` at config root. |
| **Coordinator** | Single configurable agent peer to the catalog; admits or rejects input and routes to a pipeline. |
| **Admission control** | The coordinator's reject/accept decision gating the catalog. |
| **Provider** | Auth provider (Anthropic, GitHub, …). |
| **Broker** | `CredentialBroker` — resolves credentials at invocation time. |
| **Capture** | Optional record of request/response payloads. |
| **Snapshot** | Captured state at a phase boundary (filesystem + graph + memory). |
| **Checkpoint** | LangGraph's serialized graph state. |
| **Escalation** | Request for human input that suspends the pipeline. |
| **Steering** | Mid-flight human guidance injected into a running session. |
| **MemoryStore** | Subsystem 1 — internal stateful R/W. Rollback participant. |
| **ContextProvider** | Subsystem 2 — external read-mostly retrieval client. |
| **HarnessTool** | Unified agent-callable surface. |
| **HarnessEvent** | Typed progress event in the discriminated union streamed via `harness.events()`. |
| **HarnessError** | Typed error in the discriminated union. |
| **RetryPolicy** | Declarative retry config with kind-based defaults + custom predicate escape. |
| **MCP** | Model Context Protocol. v1 = client only. |
| **ConfigStore** | Durable config substrate (load + persist runtime additions). |
| **Synthesis** | Coordinator emitting a *new* pipeline definition (v2). |
| **Job** | A persistent run request with lifecycle tracking, queued in `JobQueue`. |
| **JobQueue** | Persistent queue of pending/running/completed jobs. |
| **Workspace** | Multi-job runtime — pulls from queue, executes via library, delivers via sinks. |
| **WorktreeManager** | Per-job git-worktree allocation for filesystem isolation under concurrency. |
| **JobSource** | Plugin that pulls jobs from external systems (CLI, GH issues, Linear, cron, webhook). |
| **JobSink** | Plugin that pushes results to external systems (PR, issue comment, Slack, webhook). |
| **Local-mode** | Workspace pulling jobs from a CLI/file source on a developer's machine. |
| **Autonomous-mode** | Workspace running unattended, pulling from external sources, pushing to external sinks. |
| **Central-server pattern** | Consumer deployment topology where a server hosts shared `JobQueue` + `ConfigStore` + log aggregator + UI; workers connect via standard adapter interfaces. Not a library layer. |

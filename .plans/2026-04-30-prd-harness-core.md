# Harness Core — PRD

**Status:** Draft (2026-04-30)
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold
**Companion documents:**
- `.plans/2026-04-30-agentic-harness-design.md` — library architecture (the *types* this PRD instantiates)
- `.plans/2026-04-30-agentic-harness-implementation-plan.md` — milestone plan
- `.plans/2026-04-30-agentic-harness-ecosystem-prd.md` — ecosystem index
- `.plans/2026-04-30-prd-agent-adapter-lib.md` — **hard dependency** (every agent invocation routes through it)
- `.plans/2026-04-30-prd-auth-lib.md` — **soft dependency** (default `CredentialBroker` impl; alternative brokers allowed)
- `.plans/2026-04-30-prd-harness-server.md` — primary consumer (server form factor of this PRD)

---

## 1. Purpose

A standalone TypeScript package (`harness-core-lib`) that takes the harness *library* (types + orchestrator) and produces a **configured, runnable, credential-wired `Harness` instance** ready to execute pipelines — without prescribing a transport surface (HTTP, CLI, in-process).

The package exists because three concerns recur in every consumer that wants to *run* harness pipelines, not just import the library:

1. **Configuration loading** — pipeline catalog, profiles, plugin registry, provider definitions, escalation/retry/budget policies — read from disk (YAML/JSON), env vars, or programmatic config.
2. **Credential propagation** — a single `CredentialBroker` instance must reach every agent invocation in every phase across every adapter (`claude-sdk`, `claude-code-cli`, `opencode-cli`, …) without each consumer re-implementing the plumbing.
3. **Form-factor agnostic instantiation** — the same configured harness is wrapped by either a CLI process (single-user, env-backed) or a server process (multi-tenant, request-scoped). Both share this layer; only the transport differs.

By centralizing these concerns in one package, the harness-server (PRD `prd-harness-server.md`) becomes a thin HTTP/WS adapter on top of a configured harness, and a future single-user CLI host (`harness run pipeline …`) consumes the same primitives. New form factors — VS Code in-process, GitHub Action runner, Cursor extension — drop in without re-deriving the credential model.

**Why now:** The harness-library design is type-locked at Layer 1. Agent-adapter-lib is being extracted in parallel. Defining the configurable host before either ships keeps the harness-server's HTTP layer and the not-yet-written CLI host from each inventing their own config + credential glue.

## 2. Goals (v1)

- **One package, two form factors.** `@your-org/harness-core` exports `createConfigurableHarness(config) → ConfigurableHarness` consumed identically by CLI hosts and server hosts.
- **Declarative configuration loading.** Pipelines, profiles, plugins, providers, policies declared in YAML/JSON files (with Zod schemas) or programmatic objects; merged with deterministic precedence (defaults → file → env → programmatic override).
- **Single `CredentialBroker` per host process** propagated to every adapter invocation. Per-phase `CredentialPolicy` (already typed in harness design `:620`) enforced at the broker boundary, not inside adapters.
- **Per-user broker scoping** for server form factor — a `BrokerFactory(userContext) → CredentialBroker` produces request-scoped views of a shared credential pool, so multi-tenant deployments work without per-user re-instantiating the entire harness.
- **Token refresh + caching** — broker proactively refreshes OAuth credentials before they expire; results cached per-session so a 30-tool-call phase doesn't re-resolve credentials 30 times.
- **Credential preflight check** — before a job starts, validate every provider its phases declare needs. Fail-fast with `MissingCredentialError` listing exactly which providers are unauthenticated, rather than failing mid-phase.
- **Provider declaration in config** — pipelines declare `providers: ['anthropic', 'github']`; the host validates the broker can satisfy them all before accepting the job.
- **Form-factor-agnostic adapter wiring** — Harness Core instantiates adapters via `@your-org/agent-adapter`'s `createAgent(...)` factory; consumers swap adapters by editing config, not code.
- **Hot-reload of pipeline catalog** — `ConfigStore` integration (per harness design `:564`) means pipeline definitions can be added/edited/removed without restarting the host.

## 3. Non-Goals (v1)

- **Not a transport layer.** No HTTP, no WebSocket, no IPC. That's the harness-server's job (or a future CLI host's). This package returns a `ConfigurableHarness` object; what you wrap it with is the consumer's choice.
- **Not a multi-tenant queue / job lifecycle manager.** Job persistence, priority, worker pools, idempotency — all live in harness-server. This PRD is concerned only with *one harness instance configured correctly*; concurrency comes from the consumer wiring multiple instances or one instance with the harness library's internal scheduling.
- **Not a credential store.** Storage is delegated to `@your-org/auth-lib` (default) or any object satisfying `CredentialBroker`. No re-implementation of OAuth flows, keychain integration, or token persistence.
- **Not a pipeline authoring tool.** Pipelines are declared in config (or programmatically); this package validates and loads them. Authoring UX (visual editors, scaffolding wizards) is out of scope.
- **Not a deployment manifest generator.** Helm charts, Dockerfiles, systemd units — consumer wires them. The package ships as an importable npm dependency, not a binary.
- **Not an MCP host.** Per existing `feedback_no_mcp` policy and agent-adapter-lib §3, MCP is actively suppressed. This package never accepts MCP server definitions, never propagates them, never validates configs that reference them.

## 4. Reference & Provenance

This package extracts and consolidates configuration concerns currently distributed across three places:

| Source | What gets extracted |
|---|---|
| Harness design doc § 6.7 (`HarnessConfig`) | Authoritative top-level config shape |
| Harness design doc § 6.13 (`ConfigStore`) | Hot-reload + persistence interface |
| Harness design doc § 6.10 (`CredentialPolicy`) | Per-phase credential allowlist enforcement |
| Harness-server PRD § 4.4 (pipeline catalog endpoints) | Validation rules to apply when admin saves a pipeline |
| Agent-adapter PRD § 12 (`CredentialBroker`) | The structural type adapters consume; reused verbatim |
| Auth-lib PRD § 6 (`AuthClient`) | The default `CredentialBroker` implementation |

**Hardcoded values to think about during extraction:**
- Harness-server has implicit assumptions about Postgres-backed `ConfigStore` — this package abstracts the store and ships an `InMemoryConfigStore` + `FsConfigStore` (see harness implementation plan M3.3); the Postgres impl ships as a companion package consumed by harness-server.
- The harness library's `Harness.start()` calls `configStore.load()`. This package owns the *bootstrapping order* (load configs → validate → init broker → instantiate harness → call start).

## 5. Personas & user stories

| Persona | Need |
|---|---|
| **Iris** (installer / new user) | One config file declares pipelines + providers; `harness run` Just Works. |
| **Daisy** (developer at keyboard) | Add a new pipeline by editing YAML; existing jobs continue running unaffected. |
| **Owen** (operator / SRE) | Inspect which credentials each pipeline needs; rotate provider keys without restarting workers. |
| **Maya** (multi-tenant admin) | Each tenant has its own credentials; jobs run with the submitter's broker, not a shared one. |
| **Future CLI host author** | Wraps this package with commander, gets `harness run <pipeline>` for free without re-deriving credential plumbing. |
| **Harness-server author** | Calls `createConfigurableHarness(config)` once at boot, then routes HTTP requests to its `harness.run()` method. |

User stories:

- *As Iris*, I run `harness init`, fill in `~/.<your-org>/harness.yml` with pipeline references and provider names, log in via `auth-lib`, and `harness run plan-feature` works.
- *As Daisy*, I edit `~/.<your-org>/pipelines/my-new-pipeline.yml` and the next `harness run` call sees the new pipeline (hot-reload via `FsConfigStore`).
- *As Owen*, I run `harness preflight my-pipeline` and the host reports "needs `anthropic` and `github`; both authenticated; ready" or "missing `github` credential — run `harness auth login github`."
- *As Maya*, my harness-server receives a job from `alice@acme`, builds an `AliceCredentialBroker` view that resolves credentials from acme's OAuth pool, and runs the pipeline with no leakage between tenants.
- *As a CLI host author*, I write `import { createConfigurableHarness } from '@your-org/harness-core'` + 30 lines of commander glue and ship a single-user CLI in an afternoon.

## 6. Functional Requirements

### 6.1 Configuration loading

| ID | Requirement |
|---|---|
| F1 | Config can be loaded from: (a) a file path (YAML or JSON), (b) a directory of files (recursive merge), (c) a programmatic `HarnessConfig` object. |
| F2 | Config sources merge with precedence: programmatic overrides > env-var overrides > config files > built-in defaults. Each level produces a typed `HarnessConfig`; merge is deterministic. |
| F3 | Schema validated via Zod; invalid configs throw `ConfigValidationError` with a path-rooted message (`pipelines.fix-bug.profiles.standard.phases[2].agent.type`). |
| F4 | Config supports `$ref` for cross-file references (e.g., a pipeline references a profile defined in another file); cyclic refs detected and rejected. |
| F5 | Env-var override syntax: `HARNESS__PIPELINES__FIX_BUG__DEFAULT_PROFILE=heavy` translates to a path edit. Documented escape rules for nested keys with non-identifier characters. |
| F6 | `FsConfigStore` (from harness library) wired by default; `chokidar`-backed file watcher fires `onConfigChange` events; in-flight jobs continue with their snapshotted config, new jobs see the updated catalog. |

### 6.2 Credential propagation

| ID | Requirement |
|---|---|
| F7 | Harness Core owns one `CredentialBrokerFactory` injected at construction. Factory signature: `(ctx: BrokerContext) => CredentialBroker` where `BrokerContext = { sessionId, userId?, orgId?, jobId? }`. |
| F8 | Default factory uses `@your-org/auth-lib`'s `AuthClient` (returns the same `AuthClient` for every context — single-user mode). |
| F9 | Multi-tenant factories return per-user `CredentialBroker` views; the package ships an `MtAuthBrokerFactory(mtAuthClient)` reference impl. |
| F10 | When the harness library invokes a phase, it calls `brokerFactory({ sessionId, ...phaseCtx })` once per session, caches the result, and passes that broker to `createAgent({ ..., credentialBroker })` from `@your-org/agent-adapter`. |
| F11 | Per-phase `CredentialPolicy` enforced at the broker boundary: a wrapper `PolicyEnforcingBroker` rejects `getCredential('github')` with `CredentialDeniedError` if the current phase's policy returns `'deny'`. Adapters never see denied credentials. |
| F12 | Token refresh: brokers cache resolved credentials with `expiresAt`; on resolution within 5min of expiry, the broker proactively refreshes (delegates to `AuthClient.refresh()`). |
| F13 | Per-session caching: within one job's lifetime, repeated `getCredential('anthropic')` calls return the same cached credential object until expiry. |
| F14 | Preflight: `harness.preflight(pipelineId, profile, ctx, opts?)` returns `{ requiredProviders, missingProviders, deniedByPolicy }` *without* invoking any LLM call. When `opts.includeCost === true`, also populates `estimatedCost` via `harness.estimateCost()` (tokenizer + price-table math; still no LLM call). Default `includeCost` is `false` to keep the fast path under 100ms p95. |
| F15 | Job submission rejected before execution if `missingProviders.length > 0`; error includes remediation hint per provider (e.g., `Run "<bin> auth login anthropic"`). |

### 6.3 Pipeline catalog wiring

| ID | Requirement |
|---|---|
| F16 | Pipelines declared in config are validated against build-time registries: every `agent.type` resolvable to a registered adapter, every `prePlugin`/`postPlugin` ref resolvable, every `escalation`/`retry` policy ref resolvable, every `provider` declared in `providers:` section. |
| F17 | Validation runs on initial load AND on every `ConfigStore` change event. On **initial load**, validation failure throws (e.g., `AdapterNotInstalledError`, `UnknownPluginRefError`, `ProviderNotDeclaredError`) and prevents `harness.start()` from resolving — the host refuses to accept any session against a broken catalog. On **change events**, broken updates are rejected without affecting the previous valid catalog; in-flight jobs continue against their snapshotted version. Errors include the missing-package install command where applicable. |
| F18 | `harness.savePipeline(id, pipeline)` (per harness design line 676) routes through this package; persists via `ConfigStore`; emits `pipeline-saved` event. |
| F19 | `harness.listPipelines()` returns the union of programmatic + file + persisted pipelines; conflict resolution is precedence-based (per F2). |

### 6.4 Provider declaration & policy

| ID | Requirement |
|---|---|
| F20 | Top-level config has a `providers:` section listing every provider any pipeline can use. Format: `{ id: string, displayName: string, requiredScopes?: string[] }`. |
| F21 | Pipelines declare `requiredProviders: string[]` (e.g., `['anthropic', 'github']`). Harness Core rejects pipelines referencing undeclared providers. |
| F22 | Per-phase `contextProviders: string[]` in `PhaseConfig` (already in harness design `:489`) cross-validates against the pipeline's `requiredProviders`. |
| F23 | Default `CredentialPolicy`: a phase can use a provider iff (a) the pipeline declares it AND (b) the phase grants it via `contextProviders` or `agent.providers`. Custom policies override this default. |

### 6.5 Form factors

| ID | Requirement |
|---|---|
| F24 | **Unified CLI Engine:** This package provides the primary execution engine for the `harness` CLI's local-mode. It allows the `harness` binary to run pipelines directly on the user's machine (using the local `WorkspaceManager`) when a server is not present. |
| F25 | **Server form factor** — `@your-org/harness-core` exports a `ConfigurableHarness` class that harness-server's HTTP handlers wrap. Multi-tenant; `BrokerFactory` resolves per-request via mtauth context. |
| F26 | **In-process form factor** — VS Code extension or in-app integration imports `createConfigurableHarness({ programmaticConfig, broker: customBroker })` and calls `harness.run()` directly. No transport. |
| F27 | All three form factors invoke the same underlying methods (`harness.run`, `harness.resume`, `harness.cancel`, `harness.events`); only construction differs. |

## 7. Non-Functional Requirements

### 7.1 Latency targets

| Operation | p95 (warm) | p99 (warm) |
|---|---|---|
| `createConfigurableHarness(config)` (cold) | <500ms | <1500ms |
| Config file change → catalog updated | <300ms | <800ms |
| `broker.getCredential(provider)` (cached) | <2ms | <10ms |
| `broker.getCredential(provider)` (fresh, no refresh) | <50ms | <200ms |
| `broker.getCredential(provider)` (fresh, OAuth refresh) | <500ms | <2000ms |
| `harness.preflight(pipelineId, profile)` (no LLM) | <100ms | <300ms |

### 7.2 Reliability

- Survives malformed config file: load fails cleanly, in-flight jobs continue with last-valid catalog.
- Survives broker failure for one provider: jobs depending on that provider error with `MissingCredentialError`; jobs depending on others continue.
- Survives `ConfigStore` failure (e.g., Postgres down): in-flight jobs continue from in-memory snapshot; new pipeline writes fail with clear errors; reads fall back to last-known-good cached state.

### 7.3 Resource

- Idle RSS overhead <20MB on top of the harness library (the library itself dominates).
- Per-session credential cache memory: <1KB per session per provider (cached `Credential` objects are small).

## 8. Public API

```ts
import { createConfigurableHarness } from '@your-org/harness-core';
import { createAuthClient } from '@your-org/auth-lib';

// Single-user CLI host wiring
const auth = createAuthClient({ appName: 'harness-cli' });

const harness = await createConfigurableHarness({
  configPath: '~/.<your-org>/harness.yml',         // or configDir, or programmatic config
  brokerFactory: () => auth,                    // single user — same broker for every session
  configStore: 'fs',                            // 'fs' | 'memory' | custom impl
  logger: console,
});

await harness.start();                          // calls library's harness.start() under the hood

// Now invoke as documented in harness design doc § 6.11:
const result = await harness.run({ task: '...' }, { pipeline: 'fix-bug' });

// Server form factor wiring
const harness = await createConfigurableHarness({
  configPath: '/etc/harness/config.yml',
  brokerFactory: ({ userId, orgId }) => mtAuthBrokerFor(userId, orgId),
  configStore: customPostgresConfigStore,
});

// In a request handler:
const userBroker = harness.getBrokerForRequest({ userId: req.user.id, orgId: req.user.org });
const result = await harness.runWithBroker(input, opts, userBroker);
```

### Top-level type

```ts
export interface ConfigurableHarness extends Harness {
  // Inherited from harness library: run, resume, cancel, rollback, steer, getPending, events,
  // onEvent, estimateCost, savePipeline, deletePipeline, listPipelines, onConfigChange.

  // Additions specific to the configurable host:
  preflight(
    pipelineId: string,
    profile: string,
    ctx?: BrokerContext,
    opts?: PreflightOptions,
  ): Promise<PreflightResult>;

  /** Build a per-request broker view (server form factor). */
  getBrokerForRequest(ctx: BrokerContext): CredentialBroker;

  /** Override broker per-call (rare; used by tests + tools). */
  runWithBroker(
    input: AgentInput,
    opts: RunOptions,
    broker: CredentialBroker,
  ): Promise<RunResult>;
}

export interface PreflightOptions {
  /** When true, populate result.estimatedCost via harness.estimateCost(). Adds ~500ms p95. Default false. */
  includeCost?: boolean;
}

export interface PreflightResult {
  requiredProviders: string[];
  missingProviders: Array<{ id: string; reason: string; remediationHint: string }>;
  deniedByPolicy: Array<{ phaseId: string; provider: string; reason: string }>;
  estimatedCost?: CostEstimate;   // populated only when PreflightOptions.includeCost === true
}

export interface CreateConfigurableHarnessArgs {
  configPath?: string;
  configDir?: string;
  programmaticConfig?: Partial<HarnessConfig>;
  brokerFactory: BrokerFactory;
  configStore?: 'fs' | 'memory' | ConfigStore;
  adapterRegistry?: AdapterRegistry;            // injection point for custom adapters
  pluginRegistry?: PluginRegistry;
  policyRegistry?: PolicyRegistry;
  logger?: Logger;
}

export type BrokerFactory = (ctx: BrokerContext) => CredentialBroker;

export interface BrokerContext {
  sessionId: string;
  userId?: string;
  orgId?: string;
  jobId?: string;
  metadata?: Record<string, unknown>;
}
```

## 9. Configuration Schema

Top-level `harness.yml` layout (Zod-validated):

```yaml
# Provider declarations — every provider any pipeline can use must appear here
providers:
  anthropic:
    displayName: Anthropic Claude
    requiredScopes: ['user:inference']
  github:
    displayName: GitHub
    requiredScopes: ['repo']
  openai:
    displayName: OpenAI
    requiredScopes: []

# Default credential policy applied to all phases unless overridden
credentialPolicy:
  type: 'pipeline-declared'      # one of 'pipeline-declared' | 'phase-grants-only' | 'allow-all' | { ref: '...' }

# Pipeline catalog — references in `pipelinesDir` are loaded recursively
pipelinesDir: ./pipelines/

# Plugin / adapter / policy registries (extension points; can be programmatic-only)
pluginsDir: ./plugins/

# ConfigStore wiring — affects how savePipeline persists changes
configStore:
  type: fs                       # 'fs' | 'memory' | { ref: 'postgres' }
  path: ~/.<your-org>/harness/

# Default escalation / retry policies — phases inherit unless they override
defaultEscalation: 'never'       # built-in policy ref
defaultRetry:
  maxAttempts: 3
  backoff: 'exponential-jittered'

# Server-only: brokerFactory ref (programmatic factories are still required for non-trivial setups)
brokerFactoryRef: 'auth-lib/single-user'   # or 'mtauth/per-request'
```

A pipeline file (`pipelines/fix-bug.yml`):

```yaml
id: fix-bug
description: Diagnose and patch a small bug from a clear repro.
whenToUse:
  - User pasted a stack trace
  - Issue title contains 'fix:' or 'bug:'
requiredProviders: ['anthropic', 'github']
defaultProfile: standard
profiles:
  standard:
    phases:
      - id: diagnose
        agent: { type: claude-sdk, model: claude-sonnet-4-6, reasoningEffort: medium }
        contextProviders: ['github']
        memory: { read: true, write: false }
      - id: patch
        agent: { type: claude-code-cli, model: claude-sonnet-4-6 }
        memory: { read: true, write: true }
        requireApproval: true   # see harness design § 6.5 (the requireApproval flag we added)
```

## 10. Credential Propagation Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Harness Core (this package)                                │
│                                                                     │
│   Config files ──┐                                                  │
│   Env overrides ─┼──> ConfigLoader ──> validated HarnessConfig      │
│   Programmatic ──┘                       │                          │
│                                          ▼                          │
│   ┌─────────────────────────────────────────────────────┐           │
│   │ Harness library instance (from agentic-harness)     │           │
│   │  - pipeline catalog loaded                          │           │
│   │  - ConfigStore wired                                │           │
│   │  - listening for config changes                     │           │
│   └─────────────┬───────────────────────────────────────┘           │
│                 │ phase invocation                                  │
│                 ▼                                                   │
│   ┌─────────────────────────────────────────────────────┐           │
│   │ BrokerFactory(BrokerContext) ──> CredentialBroker   │           │
│   │  Single-user mode: returns one shared AuthClient    │           │
│   │  Server mode: returns per-user view (mtauth-backed) │           │
│   └─────────────┬───────────────────────────────────────┘           │
│                 │                                                   │
│                 ▼                                                   │
│   ┌─────────────────────────────────────────────────────┐           │
│   │ PolicyEnforcingBroker (wrapper)                     │           │
│   │  - delegates getCredential(p) to inner broker       │           │
│   │  - rejects with CredentialDeniedError if            │           │
│   │    current phase's CredentialPolicy returns 'deny'  │           │
│   │  - per-session in-memory cache                      │           │
│   │  - proactive refresh at 5min-from-expiry            │           │
│   └─────────────┬───────────────────────────────────────┘           │
│                 │                                                   │
│                 ▼                                                   │
│   ┌─────────────────────────────────────────────────────┐           │
│   │ @your-org/agent-adapter                               │           │
│   │  createAgent({ spec, workdir, credentialBroker })   │           │
│   │  Adapter calls broker.getCredential(providerId)     │           │
│   │  at invoke time, gets fresh-or-cached credential.   │           │
│   └─────────────────────────────────────────────────────┘           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Key invariant:** the credential never appears in adapter state, log output, or capture payloads. The broker resolves on-demand at invoke time; the result is held in the agent-adapter's local closure for the duration of one invocation, then dropped. The `PolicyEnforcingBroker` cache lives in the harness session's runtime context and is purged on session end.

**Multi-tenant scoping detail:** the `BrokerFactory` is invoked once per `sessionId` (i.e., once per job). The returned broker captures the user/org context closure-style; subsequent `getCredential` calls within that session resolve credentials from that user's pool. Two concurrent jobs from different users get two distinct brokers; cross-tenant credential leakage is impossible without a programming error in the factory itself.

## 11. Decisions

### Decided (v1)

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Where does this PRD slot in the ecosystem? | **Foundation layer between agent-adapter-lib and harness-server.** Sibling to auth-lib, not a deliverable in the ecosystem PRD's seven. | Foundation libs aren't user-facing surfaces; they're consumed by the surfaces. Consistent with how auth-lib is also "foundation, not surface." |
| D2 | Is this the same as `agentic-harness-runtime` (Layer 7 in implementation plan)? | **No — orthogonal.** Layer 7 is the multi-job runtime (job queue, workers, worktrees). This PRD is about credentials + config for a single harness instance. Layer 7 *consumes* this package. | Keeps "configured one harness" separable from "queued many jobs". harness-server uses both. |
| D3 | Default `CredentialBroker` impl | `@your-org/auth-lib`'s `AuthClient` directly satisfies the broker interface (per agent-adapter PRD §12). Wired automatically when `brokerFactoryRef: 'auth-lib/single-user'`. | Zero-config wiring for the common single-user case. |
| D4 | Per-phase credential policy enforcement location | At the **broker boundary** (via `PolicyEnforcingBroker` wrapper), not inside adapters. | Adapters stay credential-policy-naive; one wrapper handles all denials uniformly; auditable at one chokepoint. |
| D5 | Hot-reload semantics | In-flight jobs continue with their snapshotted config; new jobs use the latest catalog. | Avoids restart races; matches harness library's existing `ConfigStore.onChange` semantics. |
| D6 | Provider declaration redundancy with phase grants | Pipelines declare `requiredProviders` (top-level summary); phases declare `contextProviders` / `agent.providers` (granular). Validation cross-checks. | Top-level is for preflight + UX ("this pipeline needs anthropic + github"); per-phase is for least-privilege enforcement. |
| D7 | Cost estimation in preflight | **Opt-in via `preflightOpts.includeCost: true`** — when set, `preflight()` invokes `harness.estimateCost()` and populates `PreflightResult.estimatedCost`. Default is off so preflight stays sub-100ms when callers only want auth/policy gates. | Costs zero LLM tokens (tokenizer + price-table math); biggest UX win is "this'll cost ~$0.34" before submission. Opt-in keeps the fast path fast for callers who don't care. Sequencing note: depends on harness library M4.4 (cost estimation); preflight without cost ships unblocked in Phase C. |
| D8 | Unknown-adapter handling at config load | **Fail-fast at startup with `AdapterNotInstalledError`** listing the missing npm package + install command (e.g., `npm install @your-org/agent-adapter-bedrock`). Validation runs before any session is accepted; the harness refuses to `start()` with a broken catalog. | Better to crash on boot in dev/CI than to fail at job submission in production. Operators get one clear error at deploy time; users never see "your pipeline references an adapter that doesn't exist" mid-run. Same rule applies to unknown plugins / policies / providers — fail-fast at startup is the package-wide validation contract. |

### Open

| # | Question |
|---|---|
| O1 | Should config files support `!include` / Helm-style templating, or strictly static YAML? Strict is simpler; templating helps multi-environment deployments. **Lean: strict for v1; revisit if real consumers need it.** |
| O2 | Where do programmatic adapter/plugin registrations live — pure config (refs into a registry built at process start) or hybrid (config refs + late-bound `harness.registerAdapter()` API)? **Lean: pure config for v1; late-bound is post-v1 if consumers need it.** |
| O3 | Server-side BrokerFactory thread-safety: factories invoked concurrently across sessions. Document required thread-safety contract or enforce single-threaded access? **Lean: document requirement; add lint/runtime check in v1.x.** |
| O4 | `BrokerContext.metadata` — open `Record<string, unknown>` or typed extension point? **Lean: open record for v1; if patterns emerge, add typed `BrokerContextExtensions` interface in v1.x.** |

## 12. Implementation Phases

**Phase A — Skeleton + types** (~1 day)
1. Package skeleton (`package.json`, `tsconfig.json`, `vitest.config.ts`).
2. `types.ts` — `ConfigurableHarness`, `CreateConfigurableHarnessArgs`, `BrokerFactory`, `BrokerContext`, `PreflightResult`.
3. Zod schemas for `harness.yml` + per-pipeline files; `config-loader.ts` with merge precedence.

**Phase B — Config loading + validation** (~2 days)
4. File / dir / env / programmatic loading; merge logic.
5. Provider + pipeline + phase cross-validation (F16, F21, F22).
6. `FsConfigStore` integration (delegates to harness library's M3.3 implementation).
7. Hot-reload event plumbing.

**Phase C — Credential propagation** (~3 days)
8. `PolicyEnforcingBroker` wrapper with per-session cache + refresh-at-5min logic.
9. Default `CredentialPolicy` impls (`pipeline-declared`, `phase-grants-only`, `allow-all`).
10. `BrokerFactory` plumbing through harness library invocation (requires harness library hook — coordinate with implementation plan M2.5 / M2.7).
11. Preflight implementation.

**Phase D — Form factors** (~2 days)
12. Reference single-user CLI host (`@your-org/harness-core/cli`) — commander glue, ~150 lines.
13. Reference multi-tenant `BrokerFactory` (mtauth integration as opt-in companion).
14. Examples: in-process consumer, CLI consumer, server consumer.

**Phase E — Tests + docs** (~2 days)
15. Unit tests for config merge, validation, broker scoping.
16. Integration test: end-to-end run of a fixture pipeline against a mock broker.
17. Multi-tenant test: two concurrent sessions with different `BrokerContext`s; assert credential isolation.
18. README quickstart for each form factor.

**Phase F — First consumer integration**
19. Wire harness-server PRD's `HS-1` skeleton through this package; confirm credential propagation works for a real `POST /v1/jobs` flow.

Estimated calendar time: **8–10 focused days for v1**, including the harness-server integration spike.

**Sequencing note:** This package can begin Phase A in parallel with harness library Layer 1 (types are stable from L1 by "fully-typed, partially-implemented" discipline). Phase C requires harness library Layer 2 (escalation + memory tools) to be far enough along that broker invocation hooks are well-defined. Phase F gates harness-server's HS-3.

## 13. Future Work (v2+)

- **`!include` / templating in config files** (per O1).
- **Late-bound adapter registration** (per O2).
- **Programmatic config diff API** — `harness.diffConfig(newConfig)` returns what would change without applying, useful for admin UI previews.
- **Credential rotation** — broker accepts rotation events from auth-lib (e.g., a refresh-token rotation in mid-job); cached credentials invalidated and re-fetched.
- **Per-tenant config overlays** — an admin tenant can ship a base config, individual tenants overlay tweaks.
- **Pluggable preflight checks** — consumers register custom preflight validators (e.g., "verify the user has CI quota before submitting").
- **Config schema versioning** — older config files auto-migrate via a versioned adapter chain.
- **Broker observability** — emit `credential-resolved` / `credential-refreshed` / `credential-denied` events; plug into harness `events()` stream for audit dashboards.

## 14. Out-of-Scope Forever (intentional)

- **MCP support of any kind.** Same blanket constraint as agent-adapter-lib (§16). Configs that reference MCP are rejected by validation.
- **Storing credentials.** Storage is auth-lib's job. This package only *propagates* credentials it requests via the broker contract.
- **Provider invention.** New providers (Bedrock, OpenRouter, Mistral) are added to auth-lib + agent-adapter-lib; this package only consumes whatever both libs expose.
- **Acting as a transport layer.** No HTTP, no IPC, no streaming protocol. Consumers pick their transport.
- **Bundling adapters.** Adapters are peer dependencies installed separately (matches agent-adapter-lib's pattern). This package only routes through them.
- **Acting as a session/job persistence layer.** Job lifecycle storage is harness-server's responsibility (Postgres-backed). This package's session state is in-memory; long-running session continuity comes from the consumer wiring `SessionStore` (per harness design § 6.13).

## 15. Dependencies

| Dependency | Why | Hard / Soft |
|---|---|---|
| `@your-org/agent-adapter` (PRD `prd-agent-adapter-lib.md`) | Every phase invocation routes through `createAgent`. | **Hard** |
| `@your-org/auth-lib` (PRD `prd-auth-lib.md`) | Default `CredentialBroker` impl + reference single-user `BrokerFactory`. | **Soft** (pluggable; any compatible broker works) |
| `agentic-harness` library (design doc) | The `Harness` interface this package configures + instantiates. | **Hard** |
| `zod` | Schema validation. | **Hard** |
| `js-yaml` | YAML parsing. | **Hard** |
| `chokidar` | File watching for `FsConfigStore`. | **Hard** |
| `commander` | Reference CLI host wiring. | **Soft** (only for `cli` entry point) |
| `mtauth` client SDK | Reference multi-tenant `BrokerFactory`. | **Soft** (only for `mtauth` companion) |

---

*End of Harness Core PRD.*

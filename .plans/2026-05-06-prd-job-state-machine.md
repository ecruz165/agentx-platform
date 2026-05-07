# JobStateMachine (Spring Modulith module) — PRD

**Status:** Draft (2026-05-06)
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold
**Companion documents:**
- `2026-05-06-prd-control-plane.md` — umbrella for the Spring Modulith app
- `2026-05-06-prd-catalog-service.md` — supplies pipeline definitions consumed by this module
- `2026-05-06-prd-harness-router.md` — decides which harness runs each step
- `2026-05-06-prd-harness-registry.md` — what harnesses are available
- `2026-04-30-prd-harness-server.md` — TS data plane this module orchestrates
- `packages/harness-core/src/orchestrator.ts` — TS-side equivalent (`runJob`); v1 still does this in-harness, v2+ shifts orchestration here

---

## 1. Purpose

The JobStateMachine is the **server-side orchestrator** for in-flight jobs. Given a submitted job (pipelineId + productId + input), it walks the pipeline's DAG of steps, decides what runs next, dispatches each step to a harness via the HarnessRouter, and records the result in durable persistence. State persists across restarts; jobs can be paused, resumed, retried, cancelled.

It exists to move pipeline-execution logic *out of the harness process* and into the control plane. Today (per `harness-core/src/orchestrator.ts`) the harness owns the in-flight pipeline state; if the harness crashes mid-pipeline, state is lost. With the JobStateMachine in the control plane, harnesses become *stateless step executors* — they receive "run this step" RPCs and return results; the long-lived job state is the server's responsibility.

The v1 architecture is deliberately **incremental**: phases 1-2 of this module are essentially "track jobs the harness is running" without taking orchestration responsibility. Phase 3 is the real shift — orchestration migrates server-side.

## 2. Goals (v1)

- **Durable state.** In-flight job state survives Spring app restarts. Postgres-backed.
- **All pipeline step kinds supported.** Per the finalized `PipelineStep` tagged union from `harness-core`: agent, phase, loop, fork, map, conditional, retry, timeout, try, approval, call, wait, wait-for-event, transform, fail, succeed.
- **Resumability.** Jobs interrupted by harness or control-plane failure resume from the last checkpoint.
- **Cancellation.** Operators can cancel running jobs cleanly (terminate harness step + mark job failed with a reason).
- **Event stream.** Per-job event timeline accessible via SSE for live UI updates.
- **Audit trail.** Full history of state transitions persisted; every transition has a timestamp + cause.

## 3. Non-Goals (v1)

- **No re-orchestration of in-harness steps in v1.** Phases 1-2 *track* what the harness does (harness still calls `runJob` in-process); phase 3 takes orchestration server-side. v1 release ships phases 1-2.
- **No cron / scheduled jobs.** Jobs are submitted on-demand via REST. Recurring schedules are v1.x.
- **No distributed orchestration.** v1 is single-node Spring; the state machine runs on one host. Active-active replication is v2+.
- **No automatic retry beyond what `RetryStep` declares.** No "service-level" retry layer; retries are explicit in pipeline definitions via the step kind.
- **No SLA / deadline enforcement.** Per-step `timeout` is supported; per-job wall-clock deadline is v1.x.

## 4. Reference & Provenance

- The pipeline DAG types are defined in `harness-core/src/catalog.ts` (TS source) and mirrored in the Catalog module (Java). The state machine consumes whatever's in those types.
- v1 phase 3 implementation is essentially "port `orchestrator.ts:runJob()` to Java with durable state" — read that TS code as the reference algorithm.
- State machine semantics modeled after Temporal workflows (durable state, replay-based recovery, stable references to in-flight runs) but simpler — no replay; just persist transitions.
- Step kind semantics preserved exactly across TS and Java implementations to support gradual migration (some pipelines orchestrate harness-side, others server-side, simultaneously).

## 5. Personas & user stories

| Persona | Need |
|---|---|
| **Daisy (developer)** | Submit a job; watch it progress; cancel if stuck; see why it failed. |
| **Owen (operator)** | Inspect any in-flight job; see which step is currently running, how long, on which harness. |
| **CI/CD pipeline** | Submit a job programmatically, poll status, get final result with structured outcome. |
| **Auditor** | Query historical jobs; reconstruct execution order with timestamps. |

## 6. Functional Requirements

### 6.1 Job submission + lifecycle

| ID | Requirement |
|---|---|
| F1 | `POST /api/jobs` accepts `{ pipelineId, productId, input, set?, config? }`. Returns `{ jobId, status: 'queued' }`. |
| F2 | Job lifecycle states: `queued` → `running` → (`completed` | `failed` | `cancelled`). |
| F3 | Per-step states tracked separately: `pending` → `running` → (`completed` | `failed` | `skipped`). Mirrors `AgentStatus` from harness-core. |
| F4 | `GET /api/jobs/{id}` returns full job state including all step states + per-step start/end times. |
| F5 | `POST /api/jobs/{id}/cancel` initiates cancellation. Running steps are signalled to terminate; job marked `cancelling` then `cancelled`. |
| F6 | `GET /api/jobs/{id}/events` is an SSE stream of state-transition events (consumed by Web UI). |

### 6.2 Step execution dispatch (Phase 3+)

| ID | Requirement |
|---|---|
| F7 | When a step is ready to run, JobStateMachine submits a dispatch request to HarnessRouter's queue (`HarnessRouter.enqueueStep(StepContext)`). Router holds the queue, picks a harness when one becomes available, and emits `dispatch-ready` events. JSM listens for `dispatch-ready` for its own jobs and sends the step over RPC to the assigned harness. |
| F8 | The harness executes the step (e.g., spawns an LLM agent invocation, runs a transform), streams events back to JobStateMachine via the same RPC channel. |
| F9 | On step completion, JobStateMachine receives the result, persists it, decides the next step. |
| F10 | On step failure, JobStateMachine respects the surrounding `try/retry` semantics from the pipeline DAG before deciding to fail the job. |

### 6.3 DAG step kind semantics

| Step | Behavior |
|---|---|
| `agent` | Dispatch to a harness, wait for completion, advance. |
| `phase` | Emit `phase-enter` event, run body, emit `phase-exit` event, advance. |
| `loop` | Run body; check `until` condition against the most-recent step's output (default `conditionEval: 'after-each-step'`); if matches → exit (skip remaining body steps in current iteration); else iterate up to `maxIterations`. |
| `fork` | Dispatch all branches in parallel (per `join` strategy: all/any/n-of-m); aggregate per `aggregate` strategy. |
| `map` | Resolve `over` source to item list; run body once per item (parallel per `join` strategy); aggregate. |
| `conditional` | Evaluate `condition`; run `then` or `else`. |
| `retry` | Run body; on failure, retry up to `maxAttempts` with `backoff` policy. |
| `timeout` | Run body with wall-clock limit `ms`; on timeout, follow `onTimeout` policy. |
| `try` | Run `body`; on failure, run `catch` body. |
| `approval` | Pause; emit `approval-required` event; wait for `POST /api/jobs/{id}/approvals/{stepId}` with verdict. Optional `timeoutMs`. |
| `call` | Submit a sub-job for `pipelineId`; current job blocks until sub-job completes; output flows in. |
| `wait` | Sleep `ms` and advance. |
| `wait-for-event` | Pause until an external event with `eventName` is delivered to this job. |
| `transform` | Pure compute (no harness dispatch); evaluate `expression` against current state; advance. |
| `fail` | Mark job failed with `reason`. |
| `succeed` | Mark job succeeded; remaining steps skipped. |

### 6.3a Step-supporting types (locked in v1)

**`LoopCondition`** — checked per `conditionEval` setting (default after-each-body-step):
- `{ kind: 'agent-signal'; agentId; signal }` — explicit signal envelope from named agent
- `{ kind: 'output-matches'; pattern }` — substring/regex on most-recent step's text output
- `{ kind: 'iteration-limit' }` — pure max-iterations counter (no semantic break)
- `{ kind: 'intent-ready' }` — most-recent output parses as a valid `JobIntent` (canonical for JobDefinitionPipelines)
- `{ kind: 'structured-output'; schema }` — most-recent output validates against arbitrary JSON Schema

**`Predicate`** (for `ConditionalStep.condition`):
- `{ kind: 'output-matches'; pattern; fromStep? }`
- `{ kind: 'output-equals'; value; fromStep? }`
- `{ kind: 'json-path'; path; equals; fromStep? }`
- `{ kind: 'no-pipeline-matches'; fromStep }` — catalog-aware: queries Catalog at evaluation time
- `{ kind: 'pipeline-exists'; pipelineId }` — catalog lookup
- `{ kind: 'intent-ambiguous'; fromStep }` — multiple catalog matches require disambiguation

**`JoinStrategy`** (Fork + Map):
- `{ kind: 'all' }` — wait for all branches; any failure fails the parent
- `{ kind: 'any' }` — first to succeed; cancel rest
- `{ kind: 'n-of-m'; n }` — first N successes; cancel remaining when threshold met

**`AggregateStrategy`** (Fork + Map):
- `{ kind: 'array' }` — pass branch outputs as array (default)
- `{ kind: 'concat'; separator? }` — string concat
- `{ kind: 'merge-objects' }` — shallow JSON merge
- `{ kind: 'vote'; pattern; minVotes }` — count branches matching pattern
- `{ kind: 'pick-best'; scoreField }` — choose by max score
- `{ kind: 'agent'; agent }` — delegate aggregation to an LLM step

**`MapSource`** (Map's iteration source):
- `{ kind: 'from-input'; field }` — pull list from job submission input
- `{ kind: 'from-product-repos' }` — shorthand for product's repos[]
- `{ kind: 'from-step-output'; stepId; field }` — dynamic from prior step output (requires Phase 5+ runtime)
- `{ kind: 'static'; items }` — catalog-time fixed list

**`PipelineOutputContract`** (`PipelineDef.output` — drives validator + JSM emission semantics):
- `{ kind: 'agent-text' }` — default for `kind: 'work'`
- `{ kind: 'job-intent' }` — required for `kind: 'job-definition'` (e.g. intake pipelines); JSM emits `job-intent-produced` event when terminal step output parses as `JobIntent`
- `{ kind: 'job-intents'; min?; max? }` — fan-out meta-pipelines
- `{ kind: 'pipeline-spec' }` — spec-emitting (e.g., `pipeline-architect`)
- `{ kind: 'structured'; schema }` — generalized typed output

### 6.3b JobDefinitionPipeline emission semantics

| ID | Requirement |
|---|---|
| F10a | When a pipeline declared with `kind: 'job-definition'` reaches its terminal step, JSM parses the step's output. If it conforms to `JobIntent` shape, JSM emits `job-intent-produced` event with the parsed intent attached. Otherwise the job fails with `invalid-job-intent-output`. |
| F10b | `job-intent-produced` events are first-class on the JobBus — IntentService consumes them to chain into the actual work-pipeline submission. |
| F10c | Auto-generated PipelineDef outputs (from `pipeline-architect` or similar `kind: 'meta'` pipelines) emit `pipeline-spec-produced`; consumers (Catalog write API, IntentService, etc.) handle these via Approval gates before persistence. |

### 6.4 Persistence + recovery

| ID | Requirement |
|---|---|
| F11 | Postgres tables: `jobs`, `job_steps`, `job_events`. |
| F12 | After every state transition (job-level or step-level), the change is persisted before any external side effect. |
| F13 | On Spring app restart, JobStateMachine queries `jobs WHERE status IN ('queued', 'running')`, resumes each based on last persisted step state. |
| F14 | If a harness was running a step at restart time, JobStateMachine queries the harness on resume to re-establish step state — harness is the authority for in-flight step *execution*; control plane is the authority for *flow*. |
| F15 | Idempotent step dispatch: re-dispatching a step that's already running returns the existing run, doesn't start a duplicate. |

### 6.5 Concurrency + scaling

| ID | Requirement |
|---|---|
| F16 | Per-job state machine is single-threaded (Spring `@Async` or virtual threads). Multiple jobs run concurrently across multiple workers. |
| F17 | DB-backed lease prevents two app instances from running the same job's state machine (v2+ when active-active is needed). |
| F18 | Backpressure: if HarnessRouter has no available harnesses, jobs sit in `queued` state until capacity frees. |

## 7. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  JobStateMachine module                                         │
│                                                                 │
│  ┌────────────────┐     ┌──────────────────┐                   │
│  │ REST API       │     │ Job submission   │                   │
│  │ (JobsApi)      │────▶│ pipeline lookup  │                   │
│  └────────────────┘     │ (Catalog read)   │                   │
│                         └────────┬─────────┘                   │
│                                  │                             │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ State Machine Engine                                   │   │
│  │ ─────────────────────                                  │   │
│  │ Walks PipelineStep DAG; decides next step;             │   │
│  │ dispatches via HarnessRouter; awaits result;           │   │
│  │ persists transition; repeats until terminal.           │   │
│  └────┬────────────────────────────────────────────────────┘   │
│       │                                                         │
│  ┌────▼─────┐  ┌──────────────────┐  ┌─────────────────────┐   │
│  │ Postgres │  │ Event publisher  │  │ Cancellation /      │   │
│  │ (jobs,   │  │ (per-job SSE     │  │ approval handlers   │   │
│  │  steps,  │  │  channel)        │  │                     │   │
│  │  events) │  └──────────────────┘  └─────────────────────┘   │
│  └──────────┘                                                  │
└─────────────────────────────────────────────────────────────────┘
        ▲
        │ gRPC/HTTP RPC (Phase 3+)
        │
   Harness instances (run individual steps on behalf of state machine)
```

## 8. Open Questions

1. **Phase 1-2 vs Phase 3 boundary:** the early phases just *track* jobs the harness orchestrates in-process. Phase 3 *takes* orchestration. Where exactly the cutover happens is a major architectural decision — incremental migration (some pipelines orchestrate server-side, others harness-side based on a flag) is messy but safer than a big-bang switch.
2. **Step output threading:** `MapStep`'s `from-step-output` source requires reading a previous step's output. Defining the structured output contract (JSON, with shape negotiated per step kind?) is non-trivial.
3. **Approval flow:** human-in-loop approvals need persistence + UI + notification (email/Slack/etc.). v1 ships REST endpoint; integrations later.
4. **Cross-job memory:** does one job's output feed another? Currently no — each job is independent. Future: a "memory store" that survives across jobs for the same product.
5. **Sub-job (CallStep) parent-child relationship:** how strictly is the parent paused? If parent is cancelled, are children cancelled? Default: yes, cancellation propagates downward.
6. **State machine engine library:** Spring StateMachine framework, or Akka, or hand-rolled? Hand-rolled is simpler for this domain (DAG is data-driven, not states-driven). Recommend hand-rolled.

## 9. Decisions Log

| ID | Decision | Rationale | Date |
|---|---|---|---|
| D1 | Server-side orchestration is the eventual home (phase 3) | Durable state, multi-harness fan-out, cleaner cancellation. | 2026-05-06 |
| D2 | Phases 1-2 track only — orchestration stays harness-side initially | Incremental migration; reduces risk. | 2026-05-06 |
| D3 | Hand-rolled state machine engine, not a library | DAG semantics are data-driven; off-the-shelf SM libraries are over-engineered. | 2026-05-06 |
| D4 | Postgres for state persistence | Strong durability + transactions; no need for event-store complexity in v1. | 2026-05-06 |
| D5 | All step transitions persisted before side effects | Recovery correctness depends on this invariant. | 2026-05-06 |
| D6 | Step kinds and semantics mirror harness-core exactly | One source of truth (TS); Java is the durable consumer. | 2026-05-06 |

## 10. Phased delivery

| Phase | Scope |
|---|---|
| **Phase 1** | REST submission API; persists job records; harness reports back via webhook/RPC; state machine *tracks* but doesn't dispatch |
| **Phase 2** | Per-job event stream (SSE), full step-level history, cancel API |
| **Phase 3** | Server-side orchestration of `agent`, `phase`, `loop`, `fork`, `map`, `conditional`. Harness becomes step-executor. |
| **Phase 4** | `try`, `retry`, `timeout`, `approval` step kinds |
| **Phase 5** | `call`, `wait`, `wait-for-event`, `transform`, `fail`, `succeed` |
| **Phase 6** | Active-active multi-node (v2+) |

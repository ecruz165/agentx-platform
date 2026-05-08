# Intent Module (Spring Modulith) — PRD

**Status:** Draft (2026-05-07)
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold
**Module package:** `com.jefelabs.agentx.controlplane.intent`
**Companion documents:**
- `2026-05-07-prd-control-plane.md` — umbrella for the Spring Modulith app
- `2026-05-07-prd-core-module.md` — scaffolding + shared kernel (open module); `JobIntent` type lives here
- `2026-05-07-prd-job-module.md` — JobDefinitionPipelines run via JSM; emits `job-intent-produced` events
- `2026-05-07-prd-catalog-module.md` — owns pipeline definitions including `kind: 'job-definition'` pipelines
- `2026-05-07-prd-control-plane-web-ui.md` — chat UI surface that consumes Intent SSE
- `2026-05-07-prd-dispatch-module.md` — routes the steps inside JobDefinitionPipelines like any other pipeline

---

## 1. Purpose

The IntentService is the **conversational intake module** in the control plane. A user shows up with a vague request ("help me fix this bug", "I need to refactor my React components"); the IntentService runs them through an interactive dialog — driven by a **JobDefinitionPipeline** in the catalog — that narrows their intent into a concrete `JobIntent` (`{pipelineId, productId, input}`), then submits that intent to JobStateMachine to actually run the work.

It exists because the gap between "user has an idea" and "system knows what to execute" is itself a multi-turn conversation that benefits from agents (clarifying questions, classification, decomposition). Most agentic platforms hand-roll this gap; designing it as a reusable module — and crucially, using *the same pipeline machinery* the rest of the platform uses — makes the intake conversation just-another-pipeline that's authored, versioned, and observable like any other.

The architecture is deliberately small. IntentService is **a session manager and intent collector**, not a parallel agent runtime. All the heavy lifting (LLM calls, tool use, branching logic) flows through JSM via JobDefinitionPipelines.

## 2. Goals (v1)

- **Session lifecycle.** Users start an intake session via Web UI or CLI; multiple turns happen; session resolves with a JobIntent (or expires/aborts).
- **JobDefinitionPipeline orchestration.** IntentService submits the user's chosen intake pipeline (default `pipeline:default-intake`) to JSM and tracks it through completion.
- **`job-intent-produced` event consumption.** When the JobDefinitionPipeline finishes, the JSM emits a `job-intent-produced` event with the parsed JobIntent attached. IntentService catches this for the session's job, validates the intent, and submits the work-pipeline JobIntent back to JSM.
- **Auto-pipeline-creation flow.** When the JobDefinitionPipeline determines no existing pipeline matches the user's request, it can invoke `pipeline:pipeline-architect` (a meta-pipeline) which synthesizes a new PipelineDef. With admin approval, the new pipeline is registered to the catalog, and the next intake iteration finds it.
- **SSE event stream.** Per-session events (turn-added, intent-produced, job-submitted, error) stream to the Web UI/CLI for live updates.
- **Session resume.** Refreshing the browser or reconnecting from the CLI restores conversation state from the durable session record.
- **Multi-tenant.** Sessions are scoped per org; cross-org leakage prevented.

## 3. Non-Goals (v1)

- **No native LLM calls.** IntentService doesn't talk to providers directly — every LLM-driven turn flows through JSM (which dispatches to harnesses via Router, which uses adapters). One execution path for all agent work.
- **No conversation persistence beyond JobBus events.** Conversation history IS the JobDefinitionPipeline's run history (steps + their outputs). IntentService persists session metadata (id, owner, status) but the dialog content lives in the underlying job's events.
- **No template intake flows.** v1 ships exactly two intake pipelines: `default-intake` (single clarifier agent + loop until intent ready) and `smart-intake` (with auto-pipeline-creation gate). Custom intakes are catalog edits, not IntentService changes.
- **No human-to-human handoff.** A user who's stuck doesn't get routed to a human operator in v1. Could be added via `ApprovalStep` patterns later.
- **No voice / speech input.** Text-only UI; voice integration is later.
- **No anonymous sessions.** Authenticated users only — sessions tied to user identity for audit.

## 4. Reference & Provenance

- This module is the **session-management thin layer** over JSM. The pattern is "submit a JobDefinitionPipeline, listen for its `job-intent-produced` event, submit the resulting JobIntent."
- JobDefinitionPipelines + the `kind: 'job-definition'` discriminator + the `output: { kind: 'job-intent' }` contract are owned by the Catalog (PRD: catalog-service.md F3a-F3b).
- The intake-loop pattern (LoopStep + WaitForEventStep + LoopCondition `intent-ready`) is the canonical user-in-the-loop iteration.
- Inspiration: customer-support triage chatbots, AutoGen GroupChat manager, CrewAI hierarchical process. None of those expose the intake as a first-class catalog-edited concern — that's the unique angle here.

## 5. Personas & user stories

| Persona | Need |
|---|---|
| **Daisy (developer)** | Open chat in Web UI, type "help me upgrade React 17 → React 19 in skoolscout-com," answer 2-3 clarifying questions, see a JobIntent confirmation, click Run, watch the job execute. |
| **Iris (catalog admin)** | Author a custom intake pipeline (`pipeline:enterprise-intake`) for the org's specific workflow; users get routed through it instead of the default. |
| **Owen (operator)** | "Show me intake sessions that didn't resolve to a JobIntent — what's failing in our intake flow?" |
| **CI/CD pipeline** | Programmatic intake doesn't really apply — automation submits JobIntents directly. IntentService is for humans. |

## 6. Functional Requirements

### 6.1 Session lifecycle

| ID | Requirement |
|---|---|
| F1 | `POST /api/intent/sessions` starts a new session. Body: `{ pipelineId?: string, initialMessage?: string, productId?: string }`. Returns `{ sessionId, status: 'awaiting-message', intakePipelineJobId }`. Default `pipelineId: 'default-intake'`. |
| F2 | Session states: `awaiting-message` → `processing` → (`intent-ready` → `submitted` | `expired` | `aborted` | `failed`). |
| F3 | `POST /api/intent/sessions/{id}/messages` adds a user turn. Server delivers it as a `user-message` event into the underlying JobDefinitionPipeline run (which is paused in a `WaitForEventStep`). Returns immediately; UI reads response via SSE. |
| F4 | `GET /api/intent/sessions/{id}` returns full session state including current status, the underlying intake job id, and conversation history (reconstructed from the job's event log). |
| F5 | `GET /api/intent/sessions/{id}/events` SSE stream emits `turn-added`, `agent-response`, `intent-ready`, `pipeline-creation-required`, `pipeline-created`, `job-submitted`, `error`. |
| F6 | `POST /api/intent/sessions/{id}/abort` cancels the intake job; session moves to `aborted`. |
| F7 | Session timeout: if no user message for `intentSessionIdleTimeoutMs` (default 30 min), session marked `expired`; underlying intake job cancelled. |

### 6.2 JobDefinitionPipeline orchestration

| ID | Requirement |
|---|---|
| F8 | On session start, IntentService submits the chosen `pipelineId` to JSM as a job, with `kind: 'job-definition'` enforcement. JobDefinitionPipelines must declare `output: { kind: 'job-intent' }`. |
| F9 | The session's status reflects the underlying intake job's lifecycle plus IntentService-specific phases. Job-level state is the source of truth. |
| F10 | When intake job emits `job-intent-produced`, IntentService validates the produced JobIntent (calls Catalog validator + checks pipeline existence). Valid → emit `intent-ready` event with the intent. Invalid → emit `error` event with details. |
| F11 | After `intent-ready`, the user must explicitly confirm via `POST /api/intent/sessions/{id}/confirm` to actually submit the JobIntent to JSM as the work pipeline. Returns the new (work) jobId. |
| F12 | Session moves to `submitted` after confirmation; further messages are rejected. |

### 6.3 Auto-pipeline-creation flow (Phase 6+)

| ID | Requirement |
|---|---|
| F13 | When the intake JobDefinitionPipeline contains a `pipeline-architect` invocation (via CallStep) and the architect produces a `pipeline-spec`, IntentService catches the `pipeline-spec-produced` event. |
| F14 | IntentService emits `pipeline-creation-required` to the session's SSE stream — the UI shows the proposed PipelineDef and an admin-approval gate. |
| F15 | If approved (`POST /api/intent/sessions/{id}/approve-pipeline-creation` by an authorized approver), IntentService writes the new PipelineDef to Catalog with `proposalMode: 'commit'`, `created_by: 'pipeline-architect'`, `source_intent: <session id + summary>` for audit. |
| F16 | After successful pipeline registration, IntentService re-injects context into the intake job so the next loop iteration finds the new pipeline; or alternatively, the intake job continues from where it left off and the new pipeline becomes immediately findable via the existing `no-pipeline-matches` predicate now returning false. |
| F17 | Per-org rate limit: max N pipeline-architect runs per session (default 2) and per hour (default 10). Prevents loop-spam. |
| F18 | If approval is denied or times out, intake job is informed and falls through to existing-pipeline matching; failure path is `intent-not-resolvable` if nothing matches. |

### 6.4 Persistence

| ID | Requirement |
|---|---|
| F19 | Postgres table `intent_sessions`: `id`, `org_id`, `user_id`, `intake_pipeline_id`, `intake_job_id`, `status`, `created_at`, `last_activity_at`, `resolved_intent (jsonb)?`, `submitted_work_job_id?`. |
| F20 | Conversation content (user turns + agent responses) is NOT stored separately — it's reconstructable from the underlying job's event log via JSM's existing `GET /api/jobs/{id}/events`. |
| F21 | Audit log: every state transition logged with timestamp + cause. Tied to the org-wide audit infrastructure. |

### 6.5 Web UI integration

| ID | Requirement |
|---|---|
| F22 | Chat UI consumes `/api/intent/sessions/{id}/events` SSE; renders user + agent messages as bubbles. Shows status indicators: "Thinking…", "Awaiting your message…", "Generating new pipeline…", "Intent ready — review below." |
| F23 | When intent is ready, UI shows a confirmation card: pipeline name, parameters, estimated cost (if Catalog has cost metadata). User clicks Run → triggers `/confirm` endpoint. |
| F24 | When pipeline-creation is required, UI shows the proposed PipelineDef in a diff-friendly view + Approve/Reject buttons (admins only). |
| F25 | Session-history sidebar: shows past sessions for the user, click to view the session's transcript + outcome. |

## 7. Architecture

```
User                    Web UI                 IntentService           JobStateMachine        Catalog
 │                       │                          │                        │                   │
 │ types message         │                          │                        │                   │
 │──────────────────────▶│                          │                        │                   │
 │                       │ POST /sessions           │                        │                   │
 │                       │  (initial message)       │                        │                   │
 │                       │─────────────────────────▶│                        │                   │
 │                       │                          │ submit JobDefinition-  │                   │
 │                       │                          │ Pipeline               │                   │
 │                       │                          │───────────────────────▶│                   │
 │                       │                          │                        │ run pipeline      │
 │                       │                          │                        │ (clarifier agent  │
 │                       │                          │                        │  asks question)   │
 │                       │                          │                        │                   │
 │                       │                          │ ◀── 'agent-response'   │                   │
 │                       │ ◀── SSE: agent message   │                        │                   │
 │ ◀── displays bubble   │                          │                        │                   │
 │                       │                          │                        │                   │
 │ types reply           │                          │                        │                   │
 │──────────────────────▶│                          │                        │                   │
 │                       │ POST /messages           │                        │                   │
 │                       │─────────────────────────▶│                        │                   │
 │                       │                          │ deliver 'user-message' │                   │
 │                       │                          │ event into the         │                   │
 │                       │                          │ paused WaitForEvent    │                   │
 │                       │                          │───────────────────────▶│                   │
 │                       │                          │                        │ loop iterates;    │
 │                       │                          │                        │ clarifier exits   │
 │                       │                          │                        │ with JobIntent    │
 │                       │                          │                        │ output            │
 │                       │                          │                        │                   │
 │                       │                          │ ◀── 'job-intent-       │                   │
 │                       │                          │     produced'          │                   │
 │                       │                          │                        │                   │
 │                       │                          │ validate intent        │                   │
 │                       │                          │───────────────────────────────────────────▶│
 │                       │                          │ ◀───────────────── valid ──────────────────│
 │                       │ ◀── SSE: intent-ready    │                        │                   │
 │ ◀── confirmation card │                          │                        │                   │
 │                       │                          │                        │                   │
 │ clicks Run            │                          │                        │                   │
 │──────────────────────▶│                          │                        │                   │
 │                       │ POST /confirm            │                        │                   │
 │                       │─────────────────────────▶│                        │                   │
 │                       │                          │ submit work pipeline   │                   │
 │                       │                          │───────────────────────▶│                   │
 │                       │ ◀── { workJobId }        │                        │                   │
 │ ◀── job runs          │                          │                        │                   │
```

## 8. Open Questions

1. **Should IntentService support multiple concurrent intake sessions per user?** v1: yes, no limit. Could add per-user caps later if abuse.
2. **What happens if an intake job fails (e.g., LLM rate-limit)?** v1: session moves to `failed`; user can start a new session. Could add automatic retry later.
3. **Cross-session memory:** does User A's previous intake inform their next session's intake (faster narrowing for repeat patterns)? v1: no. Phase 7+: persistent user-context fed into intake agents as system prompt.
4. **Default intake pipeline shape:** simplest `default-intake` is one clarifier agent in a loop. Should `default-intake` be a singleton in the system catalog (admin-protected), or per-org-customizable? Recommend: shipped as a default that orgs can override by creating their own `pipeline:default-intake` (catalog overlay).
5. **Pipeline-architect approver:** which roles can approve auto-generated pipelines? v1: `catalog-admins` org role. Configurable per-org.
6. **Cost attribution:** the intake conversation itself uses LLM tokens (cheap, but real). Are these billed against the user, the product, or absorbed as platform overhead? Recommend: attribute to the eventual work job's product (so intake cost rolls up with the actual work it enables).
7. **Resumability:** if the central control plane restarts mid-session, the underlying intake job's state persists (per JSM), but does the user's UI reconnect cleanly? Yes if SSE reconnect logic + session id are stable; needs explicit testing.

## 9. Decisions Log

| ID | Decision | Rationale | Date |
|---|---|---|---|
| D1 | IntentService is a thin orchestrator over JSM, not a separate agent runtime | One execution path for all LLM work; reuses harnesses, adapters, billing, observability. | 2026-05-07 |
| D2 | Conversation history NOT separately stored | The underlying JSM job's event log IS the history; no duplication. | 2026-05-07 |
| D3 | Default intake = one clarifier agent in LoopStep with `intent-ready` exit | Minimum viable; pluggable per-org via catalog overlay. | 2026-05-07 |
| D4 | Auto-pipeline-creation requires explicit approval before catalog write | Prevents agent-driven catalog corruption; "PR-style" workflow. | 2026-05-07 |
| D5 | User must confirm intent before work job runs | "Are you sure?" gate prevents miscommunication-driven runs. | 2026-05-07 |
| D6 | Per-session and per-org rate limits on pipeline-architect calls | Bounds runaway loops and cost. | 2026-05-07 |

## 10. Phased delivery

| Phase | Scope |
|---|---|
| **Phase 1** | Session lifecycle (create/get/abort) + persistence; submit `default-intake` JobDefinitionPipeline; SSE for basic events |
| **Phase 2** | `job-intent-produced` event consumption + validation + confirmation flow; submit work job after `/confirm` |
| **Phase 3** | Web UI chat surface integration |
| **Phase 4** | Pipeline-creation flow with `pipeline-architect`; approval gate; catalog write |
| **Phase 5** | Per-org custom intake pipelines (catalog overlay); cross-session user memory |
| **Phase 6** | Cost attribution + billing integration; rate limits enforced via metrics |

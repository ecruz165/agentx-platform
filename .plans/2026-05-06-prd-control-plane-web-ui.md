# Control Plane Web UI — PRD

**Status:** Draft (2026-05-06)
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold
**Companion documents:**
- `2026-05-06-prd-control-plane.md` — the Spring app this UI is served from
- `2026-05-06-prd-catalog-service.md` — catalog API the UI manages
- `2026-05-06-prd-job-state-machine.md` — job execution the UI monitors

---

## 1. Purpose

The Web UI is the **browser-based management surface** for the control plane. It serves four primary user flows: (1) **conversational intake** — start an intent-narrowing chat that culminates in a submitted job (driven by IntentService + JobDefinitionPipelines); (2) **catalog management** — view/edit pipelines, agents, skills, products; (3) **live job monitoring** — watch in-flight jobs across all harnesses, with progress, logs, and per-step diff views; (4) **operator views** — see harness fleet health, routing decisions, audit trails.

It exists because the CLI (`agentx-workspace web` per the user's earlier vision) and terminal TUIs are inadequate for graph-shaped data: pipeline DAGs, fork/join structures, multi-step progress trees. A browser is the right surface for those, the same way Argo Workflows ships its own UI on top of its workflow engine.

## 2. Goals (v1)

- **Three-pane primary layout**: navigation tree (left) + main content (center) + per-item detail (right). Common pattern across Linear, Notion, GitHub.
- **Live updates via Server-Sent Events** from the Spring backend. No polling for job state; SSE pushes progress as it happens.
- **Catalog edit-then-validate-then-save flow** — edits are local until explicitly saved; saves go through the same validator the Spring service uses for `loadCatalog()`.
- **Pipeline DAG rendering** — visualize `PipelineStep` trees (with all step kinds: agent, phase, loop, fork, map, conditional, etc.) as a graph layout, not just a flat list.
- **Job timeline view** — vertical timeline of agent runs, with collapse/expand for nested fork/map branches, agent prompts/responses inline.
- **No CLI replacement.** Anything you can do in the UI can also be done via CLI/API; the UI is *additionally* available, not exclusive.

## 3. Non-Goals (v1)

- **No realtime collaboration** (Google-Docs-style multi-user editing of catalog). v1 is single-editor with conflict-on-save.
- **No code editor.** Agent system prompts and skill definitions are *edited as plain text*; v1 doesn't ship a Monaco/CodeMirror integration. Add later if user demand emerges.
- **No mobile-first responsive design.** Desktop-first; a phone-friendly layout is v2 work.
- **No offline mode.** Browser must be online to reach the control plane.
- **No A/B testing of pipelines.** Run multiple `accepts` sets per pipeline (already supported in catalog), but no in-UI A/B harness.

## 4. Reference & Provenance

- Modelled after operator UIs for similar systems: Argo Workflows (DAG rendering), Temporal Web (workflow inspection), AWS Step Functions Console (state machine visualization).
- Backend API consumed via OpenAPI-generated TypeScript client.
- Pipeline DAG visualization uses an off-the-shelf graph layout library (likely `react-flow` or `dagre`) — building a custom graph layout is out of scope.

## 5. Personas & user stories

| Persona | Need |
|---|---|
| **Daisy (developer)** | "Show me all my running jobs and let me cancel one." |
| **Owen (operator/SRE)** | "Which harnesses are unhealthy? What's the routing distribution? Are we hitting any rate limits?" |
| **Iris (catalog admin)** | "Create a new pipeline called `code-review-strict` with these 4 agents in this DAG shape; save it; verify it validates." |
| **Pat (auditor)** | "Show me every job that ran for product `skoolscout-com` last quarter, with timestamps, costs, and reviewer outcomes." |

## 6. Functional Requirements

### 6.1 Routing + layout

| ID | Requirement |
|---|---|
| F1 | Single-page app with client-side routing (`/intake`, `/catalog`, `/jobs`, `/harnesses`, `/products`, `/audit`). Hash-based or pathname-based. |
| F2 | Three-pane layout: nav tree (left, 200px-300px), main content (center, fluid), detail pane (right, 320px-480px, collapsible). |
| F3 | URL-driven state — selecting an item updates URL; URL is shareable; back button works. |
| F4 | Auth: redirects to OIDC IdP on first load; persists session via httpOnly cookie. |

### 6.2 Conversational intake (chat)

| ID | Requirement |
|---|---|
| F4a | Chat-style interface at `/intake` — message bubbles (user + assistant), input box, "submit job" button when intake completes. |
| F4b | Each session backed by IntentService — user opens intake, system starts a `JobDefinitionPipeline` run; turns of the conversation flow through SSE. |
| F4c | When IntentService emits a `job-intent-produced` event, UI shows a confirmation card with the proposed `{pipelineId, productId, input}`; user clicks "Run" to submit. |
| F4d | If the JobDefinitionPipeline triggers `pipeline-architect` (no existing pipeline matches), UI surfaces "Generating new pipeline…" status + the resulting PipelineDef for admin approval. |
| F4e | Session resume: refreshing the page restores conversation state from server-side intent_sessions table. |

### 6.3 Catalog

| ID | Requirement |
|---|---|
| F5 | Catalog tree view: Pipelines, Agents, Skills (sub-tree: Tools, Integrations, Tasks, Workflows), Products. Counts shown inline. Pipelines tagged by `kind: 'work' | 'job-definition' | 'post-job'` with visual distinguishers. |
| F6 | Pipeline detail: DAG visualization (nodes are steps; edges show flow); textual JSON view toggle. |
| F7 | Pipeline editor: form-based (per-step) + JSON editor (raw); validation feedback inline. |
| F8 | Agent detail: name, role, adapter, system prompt (editable text), accepts list, fallbackOn, skillz; preview of which skills resolve. |
| F9 | Skill catalog browse: filter by type (Tool/Integration/Task/Workflow), search by name. |
| F10 | Save flow: edit → validate (preflight POST to `/catalog/validate`) → save (POST to `/catalog/save`). Failures explain rule violations. |

### 6.3 Live job monitoring

| ID | Requirement |
|---|---|
| F11 | Jobs list: paged, filterable by status (queued/running/completed/failed), product, pipeline, time range. |
| F12 | Job detail timeline: vertical sequence of step events, with nested fork/map branches collapsible. |
| F13 | Per-agent panel: prompt sent, response received (with token counts), timestamps, model/binding used. |
| F14 | Live updates via SSE from `/jobs/{id}/events` — new events append to timeline without page refresh. |
| F15 | Cancel button on running jobs (POST to `/jobs/{id}/cancel`); confirms before destructive action. |
| F16 | Cost view: per-agent token totals, $/job estimate (using catalog's per-binding price metadata). |

### 6.4 Operator views

| ID | Requirement |
|---|---|
| F17 | Harness fleet view: each registered harness shown with last heartbeat, region/location, capabilities, current load. |
| F18 | Routing decisions panel: live stream of "job X routed to harness Y because of policy Z." |
| F19 | Audit log: searchable history of catalog edits + job submissions + harness registrations. |
| F20 | Health dashboard: aggregate metrics (jobs/sec, p50/p99 latency, error rate). |

## 7. Tech stack (proposed)

| Concern | Choice | Why |
|---|---|---|
| Framework | React 19 (or Next.js, but server-side rendering is overkill for an admin UI) | Industry standard, best ecosystem |
| Styling | Tailwind CSS | Speed of iteration |
| State | TanStack Query (server state) + Zustand or context (UI state) | Keeps server-state separate from UI-state |
| Component library | Radix UI primitives + custom components, OR shadcn/ui | Accessibility, headless flexibility |
| Graph viz | `@xyflow/react` (formerly react-flow) | Best DAG-rendering library for pipelines |
| API client | OpenAPI codegen → typed client | Type-safety end-to-end |
| Build | Vite | Fast dev loop |

## 8. Architecture / Data flow

```
Browser
  │
  │ HTTPS
  ▼
Spring Boot
  ├─ static assets (built UI bundle from /ui/dist served at /)
  ├─ REST endpoints: /api/catalog/*, /api/jobs/*, /api/harnesses/*
  ├─ SSE endpoints: /api/jobs/{id}/events
  └─ OIDC redirect handlers
```

Build pipeline:
1. UI built separately in `ui/` workspace (npm + Vite)
2. `pnpm build` produces `ui/dist/`
3. Gradle/Maven copies `ui/dist/*` into Spring's `src/main/resources/static/`
4. Spring serves at root path

## 9. Open Questions

1. **SSR or pure SPA?** SPA is sufficient for an admin UI (no SEO concerns, auth-walled). SSR adds complexity without payoff. Recommend SPA.
2. **State persistence across reloads:** which views remember their filter/scroll state via localStorage vs URL only? Recommend URL for shareable state, localStorage for per-user prefs.
3. **Theme:** light only / dark only / system? System-aware is the modern default.
4. **i18n:** v1 English only; structure copy so i18n drop-in is possible later (use a t() function from day one).
5. **Component library lock-in:** building atop Radix primitives is more work upfront but gives full design control. Using shadcn/ui (which bundles Radix + Tailwind) is faster but creates style consistency dependencies. v1 lean: shadcn/ui.
6. **Where does pipeline-DAG-rendering logic live** — purely client-side from the JSON catalog, or does Spring pre-compute a layout? Client-side is simpler and matches data-driven UI patterns.

## 10. Decisions Log

| ID | Decision | Rationale | Date |
|---|---|---|---|
| D1 | React + Vite + Tailwind + shadcn/ui | Industry-standard fast-dev stack. | 2026-05-06 |
| D2 | SPA, served as static from Spring | One container; no separate UI deploy. | 2026-05-06 |
| D3 | Server-Sent Events for live updates (not WebSocket) | One-way data flow; simpler; works with proxies; backed by Spring's `Flux<ServerSentEvent<...>>`. | 2026-05-06 |
| D4 | OpenAPI codegen for typed API client | Eliminates wire-format drift. | 2026-05-06 |
| D5 | Pipeline DAG rendered with `@xyflow/react` | Best fit for the pipeline-step graph; mature library. | 2026-05-06 |

## 11. Phased delivery

| Phase | Scope |
|---|---|
| **Phase 1** | Skeleton SPA, OIDC auth wired, navigation shell, catalog read-only view |
| **Phase 2** | Catalog editing (pipelines, agents); validation feedback |
| **Phase 3** | Job list + job detail with SSE live updates |
| **Phase 4** | Operator views: harness fleet, routing log, audit |
| **Phase 5** | Polish: cost views, audit search, theme/i18n hooks |

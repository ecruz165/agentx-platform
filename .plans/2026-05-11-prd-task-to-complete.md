# AgentX "Ready" — Detailed Breakdown

> **Reordered 2026-05-11:** Gates 1 & 2 are done. The next milestone is the **Web UI MVP** — the slice that makes "create a workspace → open the web UI → submit a job → harness-server runs the pipeline → it publishes to GitHub" true *through the browser*, end to end. Items from the old Gates 3 / 4c / 7 / 8 are pulled forward into it. The remaining standalone gates (two-tenant isolation, catalog isolation, no-op rework), then the full-HITL-verdict refactor, then hardening → AWS infra → deploy, follow. Cloud/deploy/publish items stay in the tail sections.

---

## ✅ Done

**Gate 1 — Real worker container spawn** (local Docker) — *code complete; smoke test `scripts/smoke-gate1.sh` written, not yet run on a live stack*
- 1b. `harness submit "<change>" [--product <p>] [--pipeline <id>]` — change is the positional; pipeline optional (coordinator-routed by default); posts to harness-server UDS `/v1/jobs`
- 1b.2 (added). controlplane-ui `/jobs/new` page → `POST /api/jobs`
- 1c. Worker Dockerfile installs `harness-pipeline-cli` + `harness-pipeline` wrapper (fixes stale `@agentx/*` refs); worktree mount at `<workspace>/.harness/wt/<jobId>/<subagentId>/<repoName>/` was already done in `spawn-worker.ts`
- 1d. `keepOnSuccess`/`keepOnFailure` read from `harness-workspace.yml` → `ServerCtx.worktreePolicy` → `runJobInContainer` removal flags; `harness reap` removes containers (by `harness-job-id` label) + per-repo worktrees for terminal jobs (`--force` ⇒ `git worktree remove --force`)
- 1e. `scripts/smoke-gate1.sh` — submit → poll for labeled container → assert worktree bind mount

**Gate 2 — End-to-end merge against a real GitHub repo** — *code complete; E2E `examples/20-gate2-pr-merge-e2e.ts` written, not yet run on a live repo*
- Architecture: PR/merge are `publish-*` FlowDef node kinds; GitHub creds resolve via a cascade (local `gh auth token` → controlplane-issued App token); harness-server executes, controlplane is the credential authority
- 2a. `agent-auth`'s `GitHubCredentialResolver` chain (`LocalAmbient` → `ControlplaneIssued` → `Chained`, `defaultGitHubResolver()`); `'publish'` node kind + `PublishConfig` (`push-and-open-pr` | `merge-pr`) + validator; `publish-executor.ts` runs `git push` + GitHub REST (open PR / merge PR), records `branchName`/`prUrl`/`mergeSha` on the JobRecord; orchestrator dispatch + `RunJobDeps.githubResolver`
- 2b. `ApprovalRequest.{prUrl,diffSummary}` populated in `makeApprovalExecutor`; harness-server best-effort POSTs the enriched request to controlplane when `CONTROLPLANE_URL` is set
- 2c. HITL `approve` → graph resumes → `merge-pr` node merges + records `mergeSha`; `JobRecord.{branchName,prUrl,mergeSha}`. Controlplane DB mirror (Flyway + JobDTO) deferred.
- 2d. `examples/20-gate2-pr-merge-e2e.ts` — spawn worker → stub commit → `[trigger]→[push-and-open-pr]→[merge-pr (approval)]` → approve → assert `mergeSha`

---

## ▶ NEXT — Web UI MVP

> Goal: through the browser — `workspace setup` → `workspace start` → open the web UI → submit an intent → the coordinator routes it to an existing workflow *or* you compose a new one in a guided wizard → the workflow runs on a harness-server → you watch it → approve → PR merged. HITL is **`approve | reject` only** for the MVP; the full verdict set is the iteration right after (see below). ("Workflow" = "pipeline" = `FlowDef` — same thing.) Pulls forward old 4c, 3a–3e, 7a/7b/(`approve|reject` subset of)7c, 8b–8e; adds the coordinator-routing + workflow-composer surfaces.

**W1 — Web-submitted jobs reach a harness-server** *(was Gate 4c — the keystone)*
- W1a. controlplane `HarnessRegistry` — mostly done already (the `harness` Modulith module + `controlplane/harness-server/launcher.ts` registers + heartbeats every 30s). Remaining: a `@Scheduled` liveness-eviction task (mark stale heartbeats `DISCONNECTED`); a `dispatched_to_harness_id` column on `jobs`.
- W1b. TCP listener on harness-server — add `port?` to `HarnessServerOptions`/`startHarnessServer` (binds a TCP `node:http` listener alongside the UDS); `launcher.ts` registers `endpoints: { rpc: <uds>, tcp: <http://host:port> }`.
- W1c. Dispatch path — `POST /api/jobs` reads the resolved flow's `kind`: `WORK` → `HarnessRouter.routeStep` picks a harness → a new `HarnessForwardingService` POSTs the translated job to `{endpoints.tcp}/v1/jobs` → record `dispatched_to_harness_id`. `JOB_DEFINITION`/`POST_JOB` → the existing Java `JobEngine` path (unchanged). Delete `AgentStepHandler`'s mock-execution path.
- W1d. Status sync back — harness-server's `onStatusChange` (in `launcher.ts`'s fire closure) best-effort POSTs job-level transitions to a new `POST /api/jobs/:id/status` on controlplane (same pattern as the existing `emitApprovalToControlplane`); controlplane maps harness status strings → `JobStatus` (`received`→`queued`; `awaiting-approval`/`suspended`→`running`; `completed`/`failed`/`cancelled` 1:1) and updates the row.
- W1e. Smoke: submit via the web UI → observe the container spawn on the harness-server host → observe status flow back to `/api/jobs/:id`.

**W2 — Coordinator: route to an existing workflow, or launch the composer** *(new — refines old "intent without a job id")*
- W2a. Intent submitted with no pipeline → harness-server's `runEntryCoordinator(intent, catalog, model)` classifies: `{ kind: 'existing', pipelineId }` or `{ kind: 'compose' }`. (Currently it 400s on no-match — replace that with the `compose` outcome.)
- W2b. `existing` outcome → the web UI shows "coordinator picked workflow X" with a confirm step (don't silently route); on confirm the job runs against it (→ W1's dispatch path).
- W2c. `compose` outcome → harness-server emits a "needs-new-workflow" signal to controlplane (a `PipelineSpecProposed`-shaped event — controlplane's `JobIntentListener` already handles the sibling `PipelineSpecProducedEvent` → session → `pipeline-creation-required`); the web UI opens the composer wizard (W3) seeded with the intent text.

**W3 — Guided workflow composer wizard** *(new — Composer-MVP)*
- W3a. Step 1 — Outcome type: pick the workflow's terminal `publish-*` node. `push-and-open-pr` (code → PR) is the only working option for the MVP; `write-to-filesystem` / `upload-to-s3` / `export-to-figma` shown greyed "coming soon".
- W3b. Step 2 — Steps: build the `FlowDef` (`nodes[]` + `edges[]` — the `agent` / `tool` / `gate` / `transform` / `publish` kinds in `catalog.ts`); the chain ends in the W3a outcome node.
- W3c. Step 3 — Agents: per `agent` node — model binding (the `accepts` list — per-worker model subscriptions, e.g. `local-qwen:qwen3` for a summarizer, `anthropic:claude-haiku-4-5` for a reviewer), reasoning effort, system prompt.
- W3d. Step 4 — Skills: per agent — browse + select existing skills (skillzkit), or compose a new one (reuse `controlplane-ui/src/pages/Compose.tsx` + `POST /api/skill-proposals/compose`).
- W3e. Register: validate the assembled `FlowDef` (`validateUnifiedCatalog`), `POST /api/catalog/flows` — a **new write endpoint** (the controlplane catalog module only has GET today) — returns the new pipeline id.
- W3f. Continue: re-submit the original intent's job against the now-real pipeline id → flows into W1's dispatch path.

**W4 — Job monitoring in the browser** *(was W2)*
- W4a. `controlplane-ui` `/jobs/:id` detail page — status, current node, workflow graph (which node is live), token totals.
- W4b. Live event stream — subscribe to the job's SSE (`/api/jobs/:id/events` proxied from harness-server's `/v1/jobs/:id/events`); render the envelope log.
- W4c. When a `publish` node has opened a PR, show the PR link + the `diffSummary`; link each `ChangedFile` to its diff/content view (reuses harness-server's `/v1/jobs/:id/files/...` routes).

**W5 — Browser HITL (approve / reject only)** *(was W3)*
- W5a. API: list jobs `status in [awaiting-approval, suspended]` — controlplane endpoint backed by the harness-server's `pendingApprovals` (the enriched `ApprovalRequest` arrives via the W1d best-effort POST / the existing `emitApprovalToControlplane`; controlplane caches it).
- W5b. API: fetch the `ApprovalRequest` for a job — `prUrl`, `diffSummary`, `changes: ChangedFile[]` rendered as staged file diffs in the UI.
- W5c. Decision endpoint: `POST /api/jobs/:id/approvals/:nodeId` with `{ verdict: 'approve' | 'reject', steering? }` → controlplane forwards `{ decision }` to the owning harness-server's `/v1/jobs/:id/resume` (via the W1 registry lookup). **`approve` and `reject` only for the MVP.**
- W5d. controlplane-ui `/approvals` page — the queue + the per-job review panel (diff viewer + Approve / Reject buttons; Reject prompts for optional steering text).
- W5e. Operator dry-run: submit a job whose workflow has a `merge-pr`-tagged-approval node → it pauses → approve in the browser → PR merges; then again → reject → flow retries.

**W6 — Edge services consulted at runtime** *(was W4 / old Gate 3)*
- W6a. Worker fetches context from `edge-context-server` on startup; log the query + result shape (scoped by `productId`).
- W6b. Worker reads/writes `edge-memory-server` during the run; each write tagged with `originatingJobId`.
- W6c. Provenance writes default to `status: unconfirmed`.
- W6d. PR-merge → a `feedbackSource: 'pr-merged'` event flips matching `originatingJobId` provenance entries to `positive` (hook off the `merge-pr` node's success).
- W6e. Verify: after a merged demo, query `edge-memory-server` — provenance row exists, status transitioned `unconfirmed → positive`.

**W7 — One-command workspace** *(was W5 / old Gate 8b–8e)*
- W7a. `workspace setup --product <p> --repos <r1,r2,...>` — clones repos, writes `harness-workspace.yml` + devcontainer overlays, no Python venv prompts.
- W7b. `workspace start [--embedder qwen-0.6b]` — brings up controlplane + edge servers + harness-server (+ optional Ollama / Docker-Model-Runner embedder overlay) **and the controlplane-ui dev server**; prints the web UI URL.
- W7c. `agent-auth` handles all token acquisition (GitHub via `gh` or device flow, model providers) — zero manual paste.
- W7d. Bundle Playwright browsers in the install step or auto-install on first run — no manual dance.

**W8 — The MVP demo** *(was W6)*
- W8a. (For the "existing workflow" path) author a demo `work` workflow in the catalog: `[trigger] → [agent: implement-change] → [push-and-open-pr] → [merge-pr (tagged approval)]`.
- W8b. Walk it browser-only on a low-stakes sandbox repo: `workspace setup` → `workspace start` → open the URL → submit "make change X" → coordinator routes to the demo workflow (or you compose one in the W3 wizard) → watch the agent run → PR opens → approve in the browser → PR merges → `mergeSha` on the job detail page. Zero hand-edits, zero terminal commands after `workspace start`.

---

## HITL — full verdict vocabulary (iteration right after the Web UI MVP)

> The MVP ships `approve | reject`. This iteration refactors the decision endpoint + the approval executor + the flow-graph routing to add the rest. Order is cheapest-first.

- **V1. `refine`** — `reject` with a *mandatory* refinement prompt; lands in `rejectionPayload.steering` for the retry. New verdict value + UI prompt; no flow-graph change. (~1 day)
- **V2. `nix`** — terminate the whole job from the approval gate; reuses the existing `cancelRequested` / `cancelJob` plumbing. New verdict value; graph short-circuits to `cancelled`. (~1 day)
- **V3. `decline-with-edits`** — accept the operator's edited version and continue (like `approve` but `state.output` is overwritten with `editedOutput`; for PR-centric flows the branch is already the source of truth so it's a no-op-ish "proceed"). New resume payload field + state overwrite. (~1–2 days)
- **V4. `skip`** — bypass the gated node entirely and continue to its successors. Touches the flow-graph compiler / routing (the synthetic `${nodeId}__approval` node has to route *past* `${nodeId}`). (~2–3 days)
- **V5. Authz on verdicts** — role check on the decision endpoint (who can `nix` vs. `approve` vs. `refine`); audit log of every decision (`who, when, verdict, jobId, payload`). (overlaps Hardening H3.)
- **V6. Operator dry-run** — walk through all five verdict types end-to-end.

---

## Remaining standalone gates

**Gate 4 — Two-tenant isolation** (local Neo4j; cloud provisioning deferred) — *4c pulled into W1*
- 4b. `edge-context-server` enforces `scope.productId` on every query; test that `scope.productId: acme` cannot return `widgets` entries even if the underlying repo overlaps
- 4d. Smoke: submit jobs from both tenants targeting overlapping repos in parallel; assert no cross-tenant data in either side's query results

**Gate 5 — Per-tenant catalog isolation**
- 5a. Audit catalog cache key — must include tenant/productId in the hash
- 5b. Cache invalidation on pipeline edit fires only for the editing tenant's keyspace
- 5c. Test: tenant `acme` edits its pipeline mid-flight while `widgets` has a running job; `widgets`' job continues with the unchanged pipeline definition

**Gate 6 — No-op rework gate fires from FlowDef** *(prereq for P2)*
- 6a. FlowDef primitives: confirm `gate`, `Loop`, and `retry.onMaxAttempts: escalate` are spec'd and authored (not orchestrator-coded)
- 6b. No-op detection logic — likely a diff-hash equality check across loop iterations
- 6c. On detection, emit `SuspendRequest` and park the job awaiting `event: 'operator.circuit-cleared'`
- 6d. Resume hook reads the event and continues the flow from the suspend point
- 6e. Demo pipeline that synthetically forces a no-op loop and observe the suspend/resume cycle

**P2 — Port Singularity's iterative-spec pipeline** *(after Gate 6)*
- P2a. Author the iterative-spec pipeline as a `FlowDef` using the primitives proven in Gate 6
- P2b. Run it end-to-end against a real repo with a non-trivial spec
- P2c. Confirm parity with Singularity's reference behavior on the same input

---

## Hardening — TLS & Auth (before deploy)

> Application gates land plaintext-localhost-friendly. This bolts on transport security and authentication before anything is exposed beyond a dev box.

**H1 — Transport security (TLS everywhere)**
- H1a. Internal service-to-service TLS: controlplane ↔ `edge-context-server` / `edge-memory-server` / `harness-server`. Self-signed CA OK for non-prod; cert paths configurable per-service
- H1b. Worker → controlplane TLS on job-state + provenance writes; reject plaintext in non-dev profiles
- H1c. External-facing TLS for the web UI + HITL API surface — terminate at the controlplane edge or a sidecar, not in app code
- H1d. Cert provisioning + rotation story documented (manual for now is fine — write down where the certs live and how to swap them)

**H2 — Service-to-service auth (mTLS or signed JWTs)**
- H2a. Pick the mechanism (mTLS via client certs vs. short-lived JWTs signed by controlplane); document the call
- H2b. `edge-context-server` rejects unauthenticated callers; `scope.productId` (Gate 4b) sourced from the authenticated principal, not the request body
- H2c. `edge-memory-server` same: principal-derived scope, no client-supplied tenant identity
- H2d. Worker presents a per-job credential (issued at spawn time, scoped to that `jobId`); controlplane rotates it on job completion
- H2e. Controlplane → harness-server dispatch (W1b) authenticated — the registry entry carries a shared secret / mTLS identity

**H3 — Operator / HITL auth**
- H3a. Authentication on the web UI + HITL endpoints — at minimum a bearer token; ideally OIDC/SSO hook stub
- H3b. Authorization: which operators can `nix` vs. `approve` vs. `refine` (see V5) — role check on the decision endpoint
- H3c. Audit log: every HITL decision records `who, when, verdict, jobId, payload` — append-only, queryable

**H4 — Secrets & tokens**
- H4a. GitHub App private key handled via the platform's secret store (not env vars in repo) — `agent-auth` reads from one source of truth (used by `ControlplaneGitHubResolver`)
- H4b. Model-provider keys (OpenAI/Bedrock/etc.) same treatment; rotation procedure documented
- H4c. `agent-auth` short-lived-token issuance: GitHub App installation tokens expire ≤1h, refreshed on demand; no long-lived PATs in the worker path
- H4d. Secret-scan pass on the repo; add a pre-commit hook if missing

---

## AWS Infrastructure (after hardening, before deploy)

> Provisioning the cloud substrate. Distinct from the deploy step itself.

- **AWS-1. ECS Fargate task definition** for `agentx-job-<jobId>` (image ref, task role, execution role, ephemeral storage sizing for worktree) — pulled from original 1a. Local Docker covers Gate 1 during dev.
- **AWS-2. Provision per-`productId` Neo4j databases** (or namespaces if AuraDB) on tenant onboarding; confirm `SHOW DATABASES` lists tenants separately — pulled from original 4a. Local Neo4j multi-DB covers Gate 4 during dev.
- **AWS-3. Supporting cloud resources** — ECR repo for the worker image; IAM roles referenced by AWS-1; VPC/subnet/SG so worker can reach controlplane + edge services; secrets-manager entries for the keys H4a/b stash locally.

---

## Deploy Gate (release runbook + verification)

> Required only to ship to real cloud + real users.

- **D1. Build + push worker image** to ECR; apply the AWS-1 task definition revision.
- **D2. Cloud smoke** — ECS `describe-tasks` form of the Gate 1 smoke test (local `docker ps` variant stays in Gate 1).
- **D3. Publish `@ecruz165/workspace-cli` to npm** with `workspace setup` / `workspace start` — pulled from original 8a. `pnpm link` covers W5 during dev.
- **D4. Fresh-corporate-laptop timing run**: `git clone` → `workspace setup` → `workspace start` → web UI → submitted job ≤ 10 min — pulled from original 8f. Verification on a clean machine.

---

**Suggested sequencing**
1. **Web UI MVP (W1 → W2 → W3 → W4 → W5 → W6 → W7 → W8)** — the critical path now. W1 (dispatch link) is the keystone; W2/W4/W5/W6 can partly parallelize once it lands. W3 (the composer wizard) is the biggest single chunk — it can run alongside the others.
2. **HITL full verdicts (V1 → … → V6)** — the iteration right after the MVP demo passes.
3. **Gates 4 / 5 / 6** — two-tenant + catalog isolation + no-op rework (6 is the prereq for P2).
4. **P2** — Singularity iterative-spec pipeline port.
5. **Hardening** — after the app surface is feature-complete, before any cloud provisioning.
6. **AWS Infrastructure** — after hardening so the substrate matches the hardened contracts.
7. **Deploy Gate** — the runbook to actually ship.

Want me to start on W1 (the `HarnessRegistry` + dispatch link), or break the Web UI MVP into ticket-shaped descriptions / gherkin first?

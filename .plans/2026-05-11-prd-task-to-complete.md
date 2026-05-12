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

> Goal: through the browser — `workspace setup` → `workspace start` → open the web UI → submit a job → watch the pipeline run → approve → PR merged. HITL is **`approve | reject` only** for the MVP; the full verdict set is the iteration right after (see below). Pulls forward old 4c, 3a–3e, 7a/7b/(subset)7c, 8b–8e.

**W1 — Web-submitted jobs reach a harness-server** *(was Gate 4c)*
- W1a. controlplane `HarnessRegistry` — harness-servers register on start with a base URL + heartbeats; controlplane tracks liveness
- W1b. Dispatch path: `POST /api/jobs` → persist the job → forward it to a registered harness-server (its `/v1/jobs`) instead of running it in controlplane's own Java `JobEngine`. (The Java engine stays as a fallback / for job-definition flows; *work* flows go to harness-server.)
- W1c. Status sync back: harness-server pushes job-status transitions to controlplane (or controlplane polls `/v1/jobs/:id`) so `GET /api/jobs/:id` reflects the harness-server's truth
- W1d. Smoke: submit via the web UI, observe the container spawn on the harness-server host, observe status flow back to `/api/jobs/:id`

**W2 — Job monitoring in the browser**
- W2a. `controlplane-ui` `/jobs/:id` detail page — status, current node, pipeline graph (which node is live), token totals
- W2b. Live event stream — subscribe to the job's SSE (`/api/jobs/:id/events` proxied from harness-server's `/v1/jobs/:id/events`); render the envelope log
- W2c. When a `publish` node has opened a PR, show the PR link + the `diffSummary`; link each `ChangedFile` to its diff/content view (reuses harness-server's `/v1/jobs/:id/files/...` routes)

**W3 — Browser HITL (approve / reject only)**
- W3a. API: list jobs `status in [awaiting-approval, suspended]` — controlplane endpoint backed by the harness-server's `pendingApprovals` (the enriched `ApprovalRequest` arrives via the 2b best-effort POST; controlplane caches it)
- W3b. API: fetch the `ApprovalRequest` for a job — `prUrl`, `diffSummary`, `changes: ChangedFile[]` rendered as staged file diffs in the UI
- W3c. Decision endpoint: `POST /api/jobs/:id/approvals/:nodeId` with `{ verdict: 'approve' | 'reject', steering? }` → controlplane forwards `{ decision }` to the owning harness-server's `/v1/jobs/:id/resume` (via the W1a registry lookup). **`approve` and `reject` only for the MVP.**
- W3d. controlplane-ui `/approvals` page — the queue + the per-job review panel (diff viewer + Approve / Reject buttons; Reject prompts for optional steering text)
- W3e. Operator dry-run: submit a job whose pipeline has a `merge-pr`-tagged-approval node → it pauses → approve in the browser → PR merges; then again → reject → flow retries

**W4 — Edge services consulted at runtime** *(was Gate 3)*
- W4a. Worker fetches context from `edge-context-server` on startup; log the query + result shape (scoped by `productId`)
- W4b. Worker reads/writes `edge-memory-server` during the run; each write tagged with `originatingJobId`
- W4c. Provenance writes default to `status: unconfirmed`
- W4d. PR-merge → a `feedbackSource: 'pr-merged'` event flips matching `originatingJobId` provenance entries to `positive` (hook off the `merge-pr` node's success)
- W4e. Verify: after a merged demo, query `edge-memory-server` — provenance row exists, status transitioned `unconfirmed → positive`

**W5 — One-command workspace** *(was Gate 8b–8e)*
- W5a. `workspace setup --product <p> --repos <r1,r2,...>` — clones repos, writes `harness-workspace.yml` + devcontainer overlays, no Python venv prompts
- W5b. `workspace start [--embedder qwen-0.6b]` — brings up controlplane + edge servers + harness-server (+ optional Ollama / Docker-Model-Runner embedder overlay) **and the controlplane-ui dev server**; prints the web UI URL
- W5c. `agent-auth` handles all token acquisition (GitHub via `gh` or device flow, model providers) — zero manual paste
- W5d. Bundle Playwright browsers in the install step or auto-install on first run — no manual dance

**W6 — The MVP demo**
- W6a. Author a demo pipeline in the catalog: `[trigger] → [agent: implement-change] → [push-and-open-pr] → [merge-pr (tagged approval)]`
- W6b. Walk it through the browser end-to-end on a low-stakes sandbox repo: `workspace setup` → `workspace start` → open the URL → submit "make change X" → watch the agent run → PR opens → approve → PR merges → `mergeSha` shows on the job detail page. Zero hand-edits, zero terminal commands after `workspace start`.

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
1. **Web UI MVP (W1 → W2 → W3 → W4 → W5 → W6)** — the critical path now. W1 (dispatch link) is the keystone; the rest can partly parallelize once it lands.
2. **HITL full verdicts (V1 → … → V6)** — the iteration right after the MVP demo passes.
3. **Gates 4 / 5 / 6** — two-tenant + catalog isolation + no-op rework (6 is the prereq for P2).
4. **P2** — Singularity iterative-spec pipeline port.
5. **Hardening** — after the app surface is feature-complete, before any cloud provisioning.
6. **AWS Infrastructure** — after hardening so the substrate matches the hardened contracts.
7. **Deploy Gate** — the runbook to actually ship.

Want me to start on W1 (the `HarnessRegistry` + dispatch link), or break the Web UI MVP into ticket-shaped descriptions / gherkin first?

# AgentX "Ready" — Detailed Breakdown

> Application-side gates first. Cloud/deploy/publish items are pulled out of their gates and collected in **"Deferred — Deploy & Infrastructure"** at the end. Local Docker + local Neo4j is sufficient to complete every gate below; the deferred section is what's needed to ship to real cloud + npm.

**Gate 1 — Real worker container spawn** (local Docker)
- 1b. Implement `harness submit --product <p> "<change>"` CLI that resolves productId → posts job → returns jobId
- 1c. Worker entrypoint mounts worktree at `<workspace>/.harness/wt/<jobId>/<subagentId>/<repoName>/` before launching OpenCode CLI
- 1d. Honor `keepOnSuccess: true` — clean exit retains worktree volume; cleanup only on explicit reaper pass
- 1e. Smoke test: `harness submit` → poll until `docker ps` shows running container with correct mount

**Gate 2 — End-to-end merge against a real GitHub repo**
- 2a. Worker pushes branch + opens PR via GitHub API (use the GitHub App token from `agent-auth-lib`, not PATs)
- 2b. Emit `ApprovalRequest` to controlplane with PR URL + staged diff summary on PR-open
- 2c. HITL `approve` action calls GitHub merge API; record merge SHA back to the job record
- 2d. End-to-end test on a real repo (pick a low-stakes one — maybe a TourneySeason or @jefelabs sandbox) with a non-trivial change, zero hand-edits

**Gate 3 — Edge services consulted at runtime**
- 3a. Worker fetches context from `edge-context-server` on startup; log the query + result shape
- 3b. Worker reads/writes to `edge-memory-server` during the run; each write tagged with `originatingJobId`
- 3c. Provenance writes default to `status: unconfirmed`
- 3d. PR-merge webhook (from Gate 2) emits a `feedbackSource: 'pr-merged'` event that flips matching `originatingJobId` entries to `positive`
- 3e. Verify by querying `edge-memory-server` after a merged demo: provenance row exists, status transitioned correctly

**Gate 4 — Two-tenant isolation smoke test** (local Neo4j; cloud provisioning deferred)
- 4b. `edge-context-server` enforces `scope.productId` on every query; add a test that `scope.productId: acme` cannot return `widgets` entries even if the underlying repo overlaps
- 4c. controlplane `HarnessRegistry` registers each tenant's harness with independent heartbeats
- 4d. Smoke: submit jobs from both tenants targeting overlapping repos in parallel; assert no cross-tenant data in either side's query results

**Gate 5 — Per-tenant catalog isolation**
- 5a. Audit catalog cache key — must include tenant/productId in the hash
- 5b. Cache invalidation on pipeline edit fires only for the editing tenant's keyspace
- 5c. Test: tenant `acme` edits its pipeline mid-flight while `widgets` has a running job; `widgets`' job continues with unchanged pipeline definition

**Gate 6 — No-op rework gate fires from FlowDef**
- 6a. FlowDef primitives: confirm `gate`, `Loop`, and `retry.onMaxAttempts: escalate` are spec'd and authored (not orchestrator-coded)
- 6b. No-op detection logic — likely a diff-hash equality check across loop iterations
- 6c. On detection, emit `SuspendRequest` and park the job awaiting `event: 'operator.circuit-cleared'`
- 6d. Resume hook reads the event and continues the flow from the suspend point
- 6e. Demo pipeline that synthetically forces a no-op loop and observe the suspend/resume cycle

**Gate 7 — HITL escalation surface**
- 7a. API: list jobs filtered by `status in [awaiting-approval, suspended]`
- 7b. API: fetch `ApprovalRequest.changes` rendered as staged file diffs
- 7c. Typed decision endpoint accepting `approve | decline-with-edits | refine | skip | nix` with appropriate payloads (edits for decline-with-edits, refinement prompt for refine)
- 7d. Pick one surface for ready — TUI binding is probably faster than a web UI; web can wait for P3
- 7e. Operator dry-run: walk through all five decision types end-to-end

**Gate 8 — Single-command stackup on a hostile environment** (npm publish + laptop run deferred)
- 8b. `workspace setup --product <p> --repos <r1,r2,...>` clones repos, writes overlay configs, no Python venv prompts
- 8c. `workspace start --embedder qwen-0.6b` launches Ollama + Docker-Model-Runner overlay automatically
- 8d. `agent-auth-lib` handles all token acquisition (GitHub, model providers) — zero manual paste
- 8e. Bundle Playwright browsers in the install step or auto-install on first run — no manual dance

**P2 — Port Singularity's iterative-spec pipeline (after gates 1–8)**
- P2a. Author the iterative-spec pipeline as a `FlowDef` using the primitives proven in Gate 6
- P2b. Run it end-to-end against a real repo with a non-trivial spec
- P2c. Confirm parity with Singularity's reference behavior on the same input

---

## Hardening — TLS & Auth (before deploy)

> Application gates land plaintext-localhost-friendly. This section bolts on transport security and authentication before anything is exposed beyond a dev box. Sequenced before deploy so the deployment step is "ship the already-hardened bits," not "deploy then scramble to secure."

**H1 — Transport security (TLS everywhere)**
- H1a. Internal service-to-service TLS: controlplane ↔ `edge-context-server`, controlplane ↔ `edge-memory-server`, controlplane ↔ `harness-server`. Self-signed CA acceptable for non-prod; cert paths configurable per-service
- H1b. Worker → controlplane TLS on job-state + provenance writes; reject plaintext in non-dev profiles
- H1c. External-facing TLS for the HITL API surface (Gate 7 endpoints) — terminate at the controlplane edge or a sidecar, not in app code
- H1d. Cert provisioning + rotation story documented (manual for now is fine — just write down where the certs live and how to swap them)

**H2 — Service-to-service auth (mTLS or signed JWTs)**
- H2a. Pick the mechanism (mTLS via client certs vs. short-lived JWTs signed by controlplane); document the call
- H2b. `edge-context-server` rejects unauthenticated callers; `scope.productId` from Gate 4b is sourced from the authenticated principal, not the request body
- H2c. `edge-memory-server` same: principal-derived scope, no client-supplied tenant identity
- H2d. Worker presents a per-job credential (issued at spawn time, scoped to that `jobId`); controlplane rotates it on job completion

**H3 — Operator / HITL auth**
- H3a. Authentication on the Gate 7 endpoints (`/jobs?status=awaiting-approval`, `ApprovalRequest.changes` fetch, decision endpoint) — at minimum a bearer token; ideally OIDC/SSO hook stub
- H3b. Authorization: which operators can `nix` vs. `approve` vs. `refine`; role check on the decision endpoint
- H3c. Audit log: every HITL decision records `who, when, decision, jobId, payload` — append-only, queryable

**H4 — Secrets & tokens**
- H4a. GitHub App private key handled via the platform's secret store (not env vars in repo) — `agent-auth-lib` reads from one source of truth
- H4b. Model-provider keys (OpenAI/Bedrock/etc.) same treatment; rotation procedure documented
- H4c. `agent-auth-lib` short-lived-token issuance: GitHub App installation tokens expire ≤1h, refreshed on demand; no long-lived PATs anywhere in the worker path
- H4d. Secret-scan pass on the repo: confirm no historical commits leaked keys; add pre-commit hook if missing

---

## AWS Infrastructure (after hardening, before deploy)

> Provisioning the cloud substrate. Distinct from the deploy step itself — this is "what has to exist in AWS / AuraDB before we can ship," not "ship it."

- **AWS-1. ECS Fargate task definition** for `agentx-job-<jobId>` (image ref, task role, execution role, ephemeral storage sizing for worktree) — pulled from original 1a. Local Docker covers Gate 1's 1c–1e during dev.
- **AWS-2. Provision per-`productId` Neo4j databases** (or namespaces if AuraDB) on tenant onboarding; confirm `SHOW DATABASES` lists `acme` and `widgets` separately — pulled from original 4a. Local Neo4j multi-DB covers Gate 4's 4b–4d during dev.
- **AWS-3. Supporting cloud resources** implied by the above — ECR repo for the worker image, IAM roles referenced by AWS-1, VPC/subnet/SG so worker can reach controlplane + edge services, secrets manager entries for the keys H4a/b stash locally during hardening.

---

## Deploy Gate (release runbook + verification)

> Pulled out of gates 1 and 8. None of these block application-side gate completion; they're required only to ship to real cloud + real users.

- **D1. Build + push worker image** to ECR; apply the AWS-1 task definition revision.
- **D2. Cloud smoke** — ECS `describe-tasks` form of the Gate 1 smoke test (local `docker ps` variant stays in Gate 1).
- **D3. Publish `@ecruz165/workspace-cli` to npm** with `workspace setup` and `workspace start` subcommands — pulled from original 8a. `pnpm link` covers 8b–8e during dev.
- **D4. Fresh-corporate-laptop timing run**: `git clone` → working stack → submitted job ≤ 10 min — pulled from original 8f. Verification on a clean machine, not local-dev iteration.

---

**Suggested sequencing**
- Engineering track (1→3→4→5) is the critical path — schedule risk lives here
- Authoring track (6→7) can run in parallel once primitives are frozen
- Publishing track (8 app-side: 8b–8e) is mostly verification work; do it last but don't underestimate the hostile-env shakeout
- **Hardening** runs after app gates are green and before any cloud provisioning
- **AWS Infrastructure** runs after hardening so the provisioned substrate matches the hardened service contracts
- **Deploy Gate** is the final step — the runbook to actually ship

Want me to draft acceptance criteria as gherkin/test-spec for a specific gate, or pull these into ticket-shaped descriptions?

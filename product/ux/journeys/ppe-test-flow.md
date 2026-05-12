# Test a flow

## Summary
Principal Product Engineer submits a real (sandboxed) job against a newly-authored flow, watches it run node-by-node, inspects the result, and either marks the flow ready or loops back to Compose to fix it. The "does it actually work end-to-end?" step that dry-run validation can't fully answer.

## Type
user-flow

## Personas
- [Principal Product Engineer](../personas/principal-product-engineer.md)

## Steps

### 1. Submit a test job against the flow
- **User actions:** From Compose (or SubmitJob), submit a job request targeting the product + the new flow with a small/sample input; choose a **sandbox / no-publish mode** so `publish-*` nodes don't create real PRs.
- **System:** Enqueues the job; spins up the `agentx-job-<jobId>` DevContainer; starts agents per the flow; marks it a test/sandboxed run.
- **Touchpoints:** SubmitJob screen; Compose → "Test run".
- **Pain:** `pain-test-run-side-effects` — a test run can have real side effects (open a real PR) — no sandbox/no-publish mode *(major, frequently)*.

### 2. Watch the run
- **User actions:** Open Jobs → the test job → Sessions; watch nodes execute, agent logs stream, worktree changes.
- **System:** Live status per node; current node highlighted on the flow graph; streaming logs; per-worktree changes.
- **Touchpoints:** Jobs screen; Sessions screen; job detail.
- **Pain:** `pain-job-stuck-or-slow` — can't tell which node the job is on, or whether it's stuck vs. just slow *(major, frequently)*.

### 3. Inspect the result
- **User actions:** When the job finishes/fails, inspect the output — the proposal (diff), the PR (if `publish-pr` ran), test results, logs; if a node failed, drill into the failure.
- **System:** Shows produced artifacts, per-node outcomes, failure reasons + retry affordance; a "which node failed and why" summary.
- **Touchpoints:** Jobs → job detail; Proposals (the generated output).
- **Pain:** `pain-failure-reason-buried` — failure reasons buried in logs; no per-node failure summary *(major, frequently)*.

### 4. Decide — flow's good, or iterate
- **User actions:** Either mark the flow validated/ready, or go back to Compose to fix it (loop to "Author a Flow", step 2).
- **System:** Records the test outcome against the flow version (input X → result Y, pass/fail).
- **Touchpoints:** Compose / flow detail.
- **Pain:** `pain-no-flow-test-record` — no durable record of "this flow version was tested with input X, produced Y" *(moderate, sometimes)*.

## Pain points
4 registered — 3 major, 1 moderate.

## Notes
- "Sandbox / no-publish mode" is the single highest-value affordance here — without it, nobody can safely test a flow that ends in `publish-merge`. It probably needs to be a first-class run mode (alongside "real"), surfaced anywhere a job is submitted, not just in Compose's test button.
- This flow loops with [Author a Flow](./ppe-author-flow.md) step 2 — test → fix → test. The flow version should be the anchor: each test run records against a version, so "which version is known-good" is answerable.
- Steps 2–3 overlap heavily with the Outcome Engineer's own watch/validate flow (different intent, similar screens). Confirms the earlier note: Jobs/Sessions/Proposals need per-persona lenses, not duplicate screens.

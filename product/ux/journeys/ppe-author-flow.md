# Author a Flow (FlowDef)

## Summary
Principal Product Engineer composes a **FlowDef** to cover a job-request type — pick the type, wire nodes (`clone-repo` → `load-context` → `run-agent` → `run-tests` → `publish-pr` → `publish-merge`, plus branches/conditions), validate with a dry-run, save & version. This is where **"the Flows needed to support job requests" get enumerated** — via a flow-coverage matrix mapping job-request types to FlowDefs.

## Type
user-flow

## Personas
- [Principal Product Engineer](../personas/principal-product-engineer.md)

## The flow-coverage model

A product receives **job requests** of different types; each type resolves to a **FlowDef**. The flows a product needs:

| Job-request type | What the flow does | Key nodes | Primary consumer |
|---|---|---|---|
| `implement-feature` | Take a spec kit → implement in a worktree → open a PR → optionally auto-merge if checks pass | clone → load-context → run-agent → run-tests → `publish-pr` → (`publish-merge`) | Outcome Engineer |
| `fix-bug` | Take a bug report/repro → patch → PR | clone → load-context → run-agent → run-tests → `publish-pr` | Outcome Engineer |
| `run-benchmark` | Run an agent + config against a benchmark suite → record scores | clone → load-context → run-agent → score → record | Outcome Engineer (validation) |
| `generate-research` / `generate-spec` | Take a brief → produce research / wireframes / a feature-spec kit | load-context → run-agent (product:* skillz) → package-kit | Product |
| `review-proposal` | Automated first-pass review of a generated feature before the human Outcome Engineer (lint, tests, security scan, spec-coverage) | fetch-proposal → run-checks → annotate | Outcome Engineer |
| `maintenance` / `dep-upgrade` | Scheduled: upgrade deps, cleanup, etc. | clone → run-agent (engineer:maintenance skillz) → run-tests → `publish-pr` | Principal Product Engineer |

The Compose screen's coverage view shows, per product: which of these types have a flow, which don't, and which flow is the default for each.

## Steps

### 1. Pick a flow to author / job-request type to cover
- **User actions:** Open Compose → "New flow"; name it; choose which job-request type(s) it serves; review the coverage matrix (which types already have a flow, which don't).
- **System:** Scaffolds an empty flow graph; renders the product's flow-coverage matrix highlighting uncovered job-request types.
- **Touchpoints:** Compose screen; flow-coverage view.
- **Pain:** `pain-flow-coverage-invisible` — hard to see which job-request types lack a flow *(major, always)*.

### 2. Add & wire nodes
- **User actions:** Add nodes (`clone-repo` → `load-context` → `run-agent` → `run-tests` → `publish-pr` → `publish-merge`, plus branches/conditions); wire skills/agents from the Catalog into `run-agent`; set per-node config.
- **System:** Live-validates the graph (disconnected nodes, missing required config, `publish-merge` without a preceding `publish-pr`, etc.); flags issues inline on the canvas.
- **Touchpoints:** Compose canvas; Catalog (skill/agent picker); node config panels.
- **Pain:** `pain-flow-composition-fiddly` — composing is fiddly; no "does this even work?" short of a real run *(major, frequently)*.

### 3. Validate the flow (dry-run)
- **User actions:** Run a dry-run/validation pass against a sample input (no real agent execution, no real PR); read the per-node pass/fail report.
- **System:** Walks the graph; checks each node would resolve (repo accessible, context loads, skills enabled, GitHub App token available for `publish-*`); reports pass/fail per node with reasons.
- **Touchpoints:** Compose screen → validation panel.
- **Pain:** `pain-validation-false-confidence` — validation that doesn't execute can give false confidence *(moderate, sometimes)*.

### 4. Save & version the flow
- **User actions:** Save the FlowDef with a version note; optionally mark it as the default flow for a job-request type.
- **System:** Persists the FlowDef; bumps version; updates the coverage matrix; job requests of that type now resolve to it; shows version history with rollback.
- **Touchpoints:** Compose screen; flow version history.
- **Pain:** `pain-flow-versioning-unclear` — did saving overwrite the previous version? can I roll back? *(moderate, sometimes)*.

## Pain points
4 registered — 2 major, 2 moderate.

## Notes
- The recursion: `generate-research`/`generate-spec` flows run the `product:` skillz suites; `maintenance` flows run `engineer:maintenance`. AgentX is being built to *operate* the same kits that are operating it right now. The Compose node library should expose these skillz suites as first-class node types.
- `publish-merge` should require `publish-pr` upstream — that's a structural constraint the live validator (step 2) enforces, not just a runtime check.
- Open: are flows product-scoped, or can a flow be shared across products (a library of flow templates)? Affects the coverage view (per-product vs. per-org).

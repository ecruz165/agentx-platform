# Submit a spec kit to a flow

## Summary
Outcome Engineer takes a handed-off spec kit and submits it as a job request: pick the kit from the queue → choose the flow & configure the run (sandbox vs real, overrides, iteration note) → submit (the job links back to the spec-kit version).

## Type
user-flow

## Personas
- [Outcome Engineer](../personas/outcome-engineer.md)

## Steps

### 1. Pick a spec kit from the queue
- **User:** Open SubmitJob → "Queue"; see handed-off spec kits with provenance (spec, version, persona, target product); pick one.
- **System:** Shows the kit's contents (spec, wireframes, acceptance criteria) + the target product's available flows.
- **Touchpoints:** SubmitJob screen; Queue view.
- **Pain:** `pain-queue-lacks-context` — the queue lacks priority / what-changed / why-this-kit-now context *(moderate, frequently)*.

### 2. Choose the flow & configure the run
- **User:** Pick the flow to submit against (defaults to the kit's suggested flow, e.g. `implement-feature`); set run config — repo/branch, sandbox vs real, model/agent overrides if allowed, iteration note if re-submitting.
- **System:** Validates the kit's shape fits the flow; pre-fills from the kit's suggested flow + the product's defaults; warns on mismatches.
- **Touchpoints:** SubmitJob screen; flow picker; run-config panel.
- **Pain:** `pain-kit-flow-mismatch` *(moderate, sometimes)* · `pain-run-cost-unestimated` — no time/cost estimate before committing *(moderate, sometimes)*.

### 3. Submit & confirm
- **User:** Submit the job request.
- **System:** Enqueues; resolves the kit + product context + flow into a concrete job; assigns a `jobId`; spins up `agentx-job-<jobId>`; links the job to the spec-kit version (provenance). Confirms with a link to watch.
- **Touchpoints:** SubmitJob screen → job detail.
- **Pain:** `pain-run-cost-unestimated` (same — no cost/time visibility at commit).

## Pain points
3 distinct (2 new) — all moderate.

## Notes
- This is the OE's entry point into the pipeline. The "Queue" is the join with Product's [hand-off](./product-handoff-kit.md) flow — handed-off kits land here.
- "Sandbox vs real" run mode (shared with the PPE's [test-flow](./ppe-test-flow.md)) is a first-class config knob, not a hidden flag — an OE iterating on a feature wants sandbox runs that don't open real PRs until they're confident.
- Re-submitting after a reject carries an **iteration note** — but that's a weak signal; the real fix is the structured corrections payload (see [oe-validate-feature](./oe-validate-feature.md) `pain-no-corrections-payload`).

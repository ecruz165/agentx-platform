# Validate & decide on the produced feature

## Summary
Outcome Engineer validates a produced feature against its spec: open it side by side with the spec kit → review automated checks → walk the acceptance-criteria checklist (with diff-line links) → decide **accept / reject→flow / reject→Product / iterate**. Decisions are attributable and logged (regulated environment).

## Type
user-flow

## Personas
- [Outcome Engineer](../personas/outcome-engineer.md) · [Product](../personas/product.md)

## Steps

### 1. Open the produced feature against its spec
- **User:** From Proposals (or the job outcome), open the produced feature — diff, the originating spec kit (criteria, wireframes), test results, the agent's own summary of what it did.
- **System:** Links proposal ↔ spec-kit version ↔ job; shows the spec-derived acceptance-criteria checklist alongside the diff.
- **Touchpoints:** Proposals screen; feature/proposal detail.
- **Pain:** `pain-output-vs-spec-not-side-by-side` *(major, frequently)*.

### 2. Run / review automated checks
- **User:** Look at the `review-proposal` flow's output (lint, tests, security scan, spec-coverage); run additional checks if needed.
- **System:** Shows automated-check results inline on the diff; flags spec criteria with no test coverage.
- **Touchpoints:** Proposals detail.
- **Pain:** `pain-checks-and-review-disconnected` — automated checks and human review are disconnected; re-checking by hand *(moderate, sometimes)*.

### 3. Walk the acceptance-criteria checklist
- **User:** Mark each spec criterion met/missed/ambiguous with a note + the diff line(s) it relates to; add code/security findings; flag spec ambiguities.
- **System:** Records each criterion's status; tallies a pass/fail; preserves the checklist so Product can add spec-conformance findings to the *same* one.
- **Touchpoints:** Proposals detail; the shared acceptance-criteria checklist.
- **Pain:** `pain-criteria-assessment-improvised` *(moderate, sometimes)* · `pain-diffline-criterion-unlinked` — no diff-line ↔ criterion linking → review is two disconnected reads *(moderate, frequently)*.

### 4. Decide — accept / reject→flow / reject→Product / iterate
- **User:**
  - **Accept** → approve; `publish-merge` (or a manual merge) lands it; kit lifecycle → `accepted`; audit record written.
  - **Reject → flow** → implementation missed a *correct* spec; send back with corrections; re-submit (loop to [oe-submit-kit](./oe-submit-kit.md) step 2 with an iteration note).
  - **Reject → Product** → spec was wrong/unclear; route to Product's [review-vs-spec](./product-review-vs-spec.md) / spec revision; kit lifecycle → `needs-spec-revision`.
- **System:** Records the decision + rationale (attributable, logged — regulated); routes accordingly; updates the kit lifecycle state; writes the audit entry.
- **Touchpoints:** Proposals detail; decision panel.
- **Pain:** `pain-spec-wrong-vs-impl-wrong-fork-muddy` — the reject fork is muddy *(major, sometimes)* · `pain-no-corrections-payload` — no structured "what corrections" payload when sending back to a flow → the next run repeats the mistake *(major, frequently)*.

## Pain points
6 distinct (3 new) — 3 major, 3 moderate.

## Notes
- The acceptance-criteria checklist is **one artifact, two contributors**: the OE adds code/security findings here; Product adds spec-conformance findings in [review-vs-spec](./product-review-vs-spec.md). It's also the bridge to the `review-proposal` automated flow — automated checks should *pre-populate* checklist items, not run beside them.
- `pain-no-corrections-payload` is the highest-leverage fix on the validate side: a reject→flow with just a free-text note means the agent re-runs blind. A structured payload (which criteria failed, which diff lines, what to do instead) makes iteration converge. This is essentially feeding the validation result back as new context for the next `run-agent` node.
- Step 4's "accept → publish-merge" is the Gate-2 trust boundary: the human approval is what authorizes the controlplane-issued GitHub App token to merge. The audit entry here is a compliance artifact, not just a log line.

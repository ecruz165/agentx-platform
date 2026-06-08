# Hand off a spec kit to the Outcome Engineer

## Summary
Product hands a packaged spec kit to the Outcome Engineer: select the kit + target product/flow → hand off (kit enters the OE's queue with provenance) → track its lifecycle status.

## Type
user-flow

## Personas
- [Product](../personas/product.md) · [Outcome Engineer](../personas/outcome-engineer.md)

## Steps

### 1. Select a packaged kit & target
- **User:** Pick a ready spec kit; identify the product/repo it's for; optionally the suggested flow (`implement-feature`).
- **System:** Shows the kit summary + the target product's available flows; confirms the kit is complete and the flow can accept its shape.
- **Touchpoints:** Specs surface.
- **Pain:** `pain-kit-flow-mismatch` — unclear which flow the kit should go to; kit shape vs. flow expectations can mismatch *(moderate, sometimes)*.

### 2. Hand off
- **User:** Hand the kit to the Outcome Engineer (assign / notify / queue).
- **System:** Records the handoff; the kit appears in the OE's queue with provenance (which spec, version, persona, target product/flow).
- **Touchpoints:** Specs surface; Outcome Engineer's SubmitJob queue.
- **Pain:** `pain-ownership-transfer-unclear` — no clear ownership transfer; who's responsible now? *(minor, sometimes)*.

### 3. Track status
- **User:** Watch the kit's status as the OE submits it, a job runs, a feature comes back.
- **System:** Surfaces the kit's lifecycle state: handed-off → submitted → running → produced → accepted/rejected.
- **Touchpoints:** Specs surface.
- **Pain:** `pain-lost-visibility-after-handoff` — Product loses visibility once the kit leaves their hands *(moderate, frequently)*.

## Pain points
3 registered — 1 moderate (frequent), 1 moderate, 1 minor.

## Notes
- The kit lifecycle state machine (handed-off → submitted → running → produced → accepted/rejected) is shared truth between the Specs surface (Product's view) and the SubmitJob queue / Jobs (Outcome Engineer's view). Same state, two lenses — again.
- Handoff might be a no-op in a solo-user world (Product and Outcome Engineer are the same person wearing two hats) — but the *provenance link* (kit → job → feature) must persist regardless, because the review-vs-spec flow depends on it.

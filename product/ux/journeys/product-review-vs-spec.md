# Review implementation against the spec

## Summary
When a feature comes back, Product reviews it against the originating spec kit: open the produced feature (diff + kit side by side) → assess against the spec's acceptance criteria → decide *spec was right* (send back to the flow) vs *spec was wrong* (revise the kit, bump version, re-hand-off).

## Type
user-flow

## Personas
- [Product](../personas/product.md) · [Outcome Engineer](../personas/outcome-engineer.md)

## Steps

### 1. Open the produced feature
- **User:** From the Specs surface (or Proposals), open the feature a flow produced for this kit; see the diff + the originating kit side by side.
- **System:** Links the proposal/PR to the originating spec kit; shows the spec's acceptance criteria alongside the diff.
- **Touchpoints:** Specs surface; Proposals.
- **Pain:** `pain-output-vs-spec-not-side-by-side` — can't see the produced feature against its spec (criteria, wireframes) in one place *(major, frequently)*.

### 2. Assess against acceptance criteria
- **User:** Walk the spec's acceptance criteria against the implementation; mark each met/missed/ambiguous with a note; flag spec ambiguities the implementation surfaced.
- **System:** Renders a spec-derived checklist; records each criterion's status + note.
- **Touchpoints:** Proposals; Specs surface.
- **Pain:** `pain-criteria-assessment-improvised` — assessment is improvised, not a structured checklist *(moderate, sometimes)*.

### 3. Decide — spec was right (back to flow) / spec was wrong (revise spec)
- **User:** Fork — implementation missed a *correct* spec → send back to the flow (Outcome Engineer re-submits). Spec was unclear/wrong → revise the spec kit (loop to [Spec a feature](./product-spec-feature.md), bump version) and re-hand-off.
- **System:** Records the decision + rationale; routes accordingly; bumps the relevant version (flow re-run vs. kit revision).
- **Touchpoints:** Specs surface; Proposals.
- **Pain:** `pain-spec-wrong-vs-impl-wrong-fork-muddy` — the fork is muddy; features get misrouted *(major, sometimes)*.

## Pain points
3 registered — 2 major, 1 moderate.

## Notes
- This is the closing arc of the pipeline loop: Product specs → OE submits & validates → feature comes back → **here** → either back to OE's flow or back to Product's spec. The "muddy fork" pain (step 3) is the most important to solve — misrouting wastes a full implementation cycle.
- Overlaps with the Outcome Engineer's own validate flow (the OE does a *technical* validation; Product does a *spec-conformance* validation) — they should share the acceptance-criteria checklist, with the OE adding code/security findings and Product adding spec/scope findings. One artifact, two contributors.
- The provenance link (kit version ↔ job ↔ feature) from [product-handoff-kit](./product-handoff-kit.md) is what makes step 1's side-by-side possible.

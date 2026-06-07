# Spec a feature (build a spec kit)

## Summary
Product persona builds a **spec kit** — one versioned object bundling research + wireframes + feature spec + user stories (mirrors `product/.pencil-ux.json` + `.pen` files + a feature-spec doc). Frame the feature → generate/attach research → produce wireframes → write the spec + acceptance criteria + stories → package & version.

## Type
user-flow

## Personas
- [Product](../personas/product.md)

## Steps

### 1. Frame the feature / start a spec kit
- **User:** Open the Specs/Feature-Kits surface → "New feature kit"; name it; write the problem statement / intent; link the persona(s) it serves.
- **System:** Creates a draft spec kit; shows its sections (research → wireframes → feature spec → stories) as a checklist.
- **Touchpoints:** Specs / Feature-Kits surface.
- **Pain:** `pain-spec-kit-not-one-object` — research/wireframes/spec are scattered docs, not one packaged versioned object *(major, always)* — the kit-as-object design is the proposed fix.

### 2. Generate / attach research
- **User:** Run a `generate-research` job against a brief, OR attach existing research; review and link the findings that matter.
- **System:** If generating: submits the job, shows progress, attaches the result. If attaching: links it. Findings become citable from spec sections later.
- **Touchpoints:** Specs surface; SubmitJob (the research-generating flow); Jobs (watch it).
- **Pain:** `pain-research-not-traceable-to-spec` — can't tell which research finding drove which spec decision *(major, frequently)*.

### 3. Produce wireframes
- **User:** Open Pencil (or a `generate-wireframes` job) to produce low-fi screens; review; attach the `.pen` artifacts; link each wireframe to the spec section it realizes.
- **System:** Links the `.pen` artifacts to the kit; shows them inline; tracks the wireframe ↔ spec-section mapping.
- **Touchpoints:** Specs surface; Pencil / `.pen`; `generate-wireframes` flow (optional).
- **Pain:** `pain-wireframes-drift-from-spec` — wireframes drift from the spec; no link between a wireframe and the spec section it realizes *(major, frequently)*.

### 4. Write the feature spec + acceptance criteria + stories
- **User:** Write the feature spec (scope, behavior, constraints incl. regulated-data, out-of-scope); derive the user stories; set acceptance criteria per story (Given/When/Then).
- **System:** Validates the spec has the required sections; flags missing regulated-data handling if the feature/persona touches user/student data; lists the implied stories.
- **Touchpoints:** Specs surface.
- **Pain:** `pain-regulated-constraints-forgotten` *(moderate, sometimes)* · `pain-spec-structure-not-enforced` *(moderate, sometimes)*.

### 5. Package & version the spec kit
- **User:** Review the assembled kit; package it; give it a version note; mark it ready to hand off.
- **System:** Bundles into a versioned spec-kit artifact; marks it available to the Outcome Engineer; shows version history.
- **Touchpoints:** Specs surface.
- **Pain:** `pain-kit-not-self-contained` — hard to tell if a packaged kit is complete *(moderate, sometimes)*.

## Pain points
6 registered — 3 major, 3 moderate.

## Notes
- The "spec kit" object should *be* the skillz `product:` artifacts, packaged: `product/.pencil-ux.json` slices (the personas/journeys/stories for this feature) + the `.pen` wireframes + a feature-spec markdown doc, all version-pinned together. Don't invent a new format.
- Steps 2 and 3 can each be a `generate-*` flow (the recursion) — Product *runs* AgentX flows to produce parts of the spec kit that AgentX will then implement. The Specs surface needs to embed job-watching, not just be a static editor.
- The wireframe ↔ spec-section mapping (step 3) is what prevents drift — and it's what the Outcome Engineer's review checklist (see [product-review-vs-spec](./product-review-vs-spec.md)) keys off.

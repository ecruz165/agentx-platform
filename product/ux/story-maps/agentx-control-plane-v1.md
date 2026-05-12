# AgentX Control Plane v1 — Story Map

## Anchor
**Operators turn product specs into safely-shipped, validated features via agent flows.**

## Journeys covered
The 9 user-flows in `product/.pencil-ux.json` (PPE: register-product, author-flow, test-flow · Product: spec-feature, handoff-kit, review-vs-spec · OE: submit-kit, watch-run, validate-feature).

## Backbone (left → right, pipeline order)

The 33 stories from `product/.pencil-ux.json` stacked under their backbone step. **Bold** = in the v1 walking skeleton; the rest are v1.1+ depth.

### 1 · Set up a product — *Intake* — (PPE)
- **story-ppe-register-product** — register a product in one guided flow `M`
- **story-ppe-attach-repos** — attach repos + confirm GitHub App access `M`
- **story-ppe-preview-context-source** — preview what the context source will load `M`
- story-ppe-activate-product-warns-no-flows — warn (don't block) on activating with no flows `S`

### 2 · Author & test flows — *Compose* — (PPE)
- **story-ppe-flow-coverage-matrix** — see which job-request types have a flow `M`
- **story-ppe-compose-flow-nodes** — compose a FlowDef by wiring nodes `L` *(flow-graph widget)*
- **story-ppe-flow-live-validation** — live-validate the flow graph while editing `M`
- **story-ppe-sandbox-run-mode** — sandbox / no-publish run mode `M`
- **story-ppe-test-flow-and-iterate** — test a flow and loop back to the composer `M`
- story-ppe-flow-dry-run — dry-run a flow against a sample input `M`
- story-ppe-flow-versioning — version FlowDefs with history + rollback `M`

### 3 · Browse & enable skills — *Catalog* — (all)
- **story-catalog-browse-and-enable** — browse the catalog + enable skills for the org `M`

### 4 · Spec a feature — *Specs / Feature-Kits* (NEW screen) — (Product)
- **story-product-spec-kit-as-object** — a spec kit is one versioned object `L`
- story-product-research-traceable — cite research findings from spec sections `M`
- story-product-wireframe-spec-mapping — link each wireframe to the spec section it realizes `M`
- story-product-spec-structure-enforced — spec editor requires the structural sections `S`
- story-product-package-version-kit — package + version a kit with a completeness check `M`
- story-product-embed-generate-flows — run generate-* flows from inside the spec kit `M`

### 5 · Hand off a spec kit — *Specs → OE queue* — (Product)
- **story-product-handoff-with-provenance** — hand off a kit with provenance into the OE queue `M`
- story-product-track-kit-lifecycle — track a kit's lifecycle after handoff `M`

### 6 · Submit a job — *SubmitJob* — (OE)
- **story-oe-submit-from-queue** — submit a kit from the queue with the right context `M`

### 7 · Watch the run — *Jobs* — (OE, PPE)
- **story-job-flow-graph-current-node** — job flow graph with the current node highlighted `M` *(flow-graph widget)*
- **story-job-failure-summary** — "which node failed and why" summary on a failed job `M`
- story-job-intervene-clear-effects — job actions state their effects before confirming `S`
- story-job-cost-time-visibility — live + final cost/time/token spend on a job `S`

### 8 · Inspect agent work — *Sessions* — (OE, PPE)
- *(v1: the existing basic streaming-log + worktree-diff view is "good enough" for the walking skeleton)*
- story-job-decision-trace-not-firehose — a decision trace above the raw log stream `L`
- story-job-multi-agent-view — manageable N-agent × M-worktree watch view `M`

### 9 · Validate & decide — *Proposals* — (OE, Product)
- **story-review-output-vs-spec-side-by-side** — produced feature side-by-side with its spec `M`
- **story-review-acceptance-criteria-checklist** — shared, diff-linked acceptance-criteria checklist `L` *(checklist widget)*
- **story-review-decision-and-route** — decide accept / reject→flow / reject→Product with audit `M`
- **story-accept-publishes-merge** — accepting a feature authorizes publish-merge `M`
- story-review-automated-checks-prepopulate — automated checks pre-populate the review checklist `M`
- story-review-corrections-payload — reject→flow carries a structured corrections payload `M`

### 10 · Benchmark outcomes — *Benchmarks / BenchmarkRun* — (OE)
- *(not yet flow-mapped or storied — backbone placeholder, out of v1 scope)*

## Slices

### v1 — walking skeleton  *(18 stories; status: planned; no target date set)*
Smallest end-to-end pipeline: register a product → author + test a flow → spec a kit → hand off → submit a job → watch it → validate & merge. Thin per screen, complete across the whole loop. Backbone step 8 (Sessions) covered by the existing basic streaming view; step 10 (Benchmarks) out of scope.

### v1.1+ — depth (no new screens)  *(15 stories; status: planned)*
Deepen the v1 screens — activation warnings, dry-run, flow versioning, decision-trace + multi-agent Sessions, intervention effect-clarity, cost/time visibility, research traceability, wireframe↔spec mapping, spec structure enforcement, kit packaging completeness, embedded generate-* flows, kit lifecycle tracking, automated-checks pre-population, corrections payload. Split further via `/product:ux:story-maps:slice` when ready.

## Cross-cutting (not screens — composite components for `packages/design-system`)
- **flow-graph widget** — Compose canvas (edit mode) + Jobs detail (running mode), same component two states. Stories tagged `flow-graph-widget`.
- **acceptance-criteria checklist widget** — Proposals + Specs review, diff-linked, multi-contributor. Stories tagged `checklist-widget`.
- **provenance link** `spec-kit version ↔ job ↔ produced feature` — the data spine every "track status" / side-by-side / audit view hangs off. A controlplane schema concern, not a UI one.

## Notes
- The v1 slice traces the *whole* pipeline at minimal depth — a real job can run end-to-end on day one. The v1.1+ stories add depth, not breadth: none introduces a new screen, which is a good sign the screen inventory is stable.
- Per-persona lenses, not duplicate screens: Jobs / Sessions / Proposals each serve 2+ personas with different intent. The backbone encodes this as one column per screen with stories from multiple personas stacked under it.
- Next: low-fi wireframes (`/product:design:explore`) for the v1 screens — Intake, Compose, Catalog, Specs/Feature-Kits, SubmitJob, Jobs, Sessions, Proposals — produced as `.pen` files (needs the Pencil app + MCP running; not connecting yet).

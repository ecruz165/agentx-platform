# AgentX Control Plane v1 — Story Map

## Anchor
**Operators turn product specs into safely-shipped, validated features via agent flows.**

## Journeys covered
The 9 user-flows in `product/.pencil-ux.json` (PPE: register-product, author-flow, test-flow · Product: spec-feature, handoff-kit, review-vs-spec · OE: submit-kit, watch-run, validate-feature). All v1 screens are now wireframed in `product/design/wireframes/control-plane-v1.pen` (15 frames); see the **Screen ↔ wireframe map** below.

## Backbone (left → right, pipeline order)

The 35 stories from `product/.pencil-ux.json` stacked under their backbone step. **Bold** = in the v1 walking skeleton; the rest are v1.1+ depth.

### 1 · Set up a product — *Intake* — (PPE)
- **story-ppe-register-product** — register a product in one guided flow `M`
- **story-ppe-attach-repos** — attach repos + confirm GitHub App access `M`
- **story-ppe-preview-context-source** — preview what the context source will load `M`
- story-ppe-activate-product-warns-no-flows — warn (don't block) on activating with no flows `S`

*Wireframed as a product = identity + context sources (websites / external repos / openDoc specs) + product repos + publishing targets with a default.*

### 2 · Author & test flows — *Compose* (+ *Flows* catalog) — (PPE)
- **story-ppe-flow-coverage-matrix** — see which job-request types have a flow `M`
- **story-ppe-compose-flow-nodes** — compose a FlowDef by wiring nodes `L` *(flow-graph widget)*
- **story-ppe-flow-live-validation** — live-validate the flow graph while editing `M`
- **story-ppe-sandbox-run-mode** — sandbox / no-publish run mode `M`
- **story-ppe-test-flow-and-iterate** — test a flow and loop back to the composer `M`
- story-ppe-flow-dry-run — dry-run a flow against a sample input `M`
- story-ppe-flow-versioning — version FlowDefs with history + rollback `M`
- story-flows-catalog-and-provenance — browse FlowDefs by kind (work / job-definition / post-job) with provenance (authored in Compose ↔ promoted from a skillzkit workflow) + a valid/issue badge, "Open in Compose →" `M` *(added — Flows screen)*

*Compose is the editor; **Flows** is the list/management view of the same FlowDefs (a separate nav destination, folded into this step rather than a new backbone column).*

### 3 · Browse & enable skills + agents — *Skills* (+ *Agents*) — (all)
- **story-catalog-browse-and-enable** — browse the catalog + enable skills for the org `M` *(reworked to the skillzkit taxonomy: skills = 4 kinds — workflows / tasks / tools(CLI) / integrations(REST); a workflow has many tasks with persistence points, usable inside a Flow or promoted to one)*
- story-agents-browse-and-enable — browse + enable agents (LLM executors that flow agent-nodes bind to: accepts &lt;skills&gt; · binding &lt;pref→fallback&gt; · effort) `M` *(added — Agents screen)*

*skillzkit is upstream source of truth (see [[project_skillzkit_is_skill_source_of_truth]]); controlplane provides per-org browse + enable. Skills / Agents / Flows are three nav destinations folded into steps 2–3, not three new backbone columns.*

### 4 · Spec a feature — *Feature Kit* — (Product)
- **story-product-spec-kit-as-object** — a spec kit is one versioned object `L`
- story-product-research-traceable — cite research findings from spec sections `M`
- story-product-wireframe-spec-mapping — link each wireframe to the spec section it realizes `M`
- story-product-spec-structure-enforced — spec editor requires the structural sections `S`
- story-product-package-version-kit — package + version a kit with a completeness check `M`
- story-product-embed-generate-flows — run generate-* flows from inside the spec kit `M`

*Wireframed as the Feature Kit screen: sections-completeness strip + Research / Wireframes (↔ §-mapping) / Feature-spec (regulated-data §3 flagged FERPA/COPPA) / Acceptance-criteria cards.*

### 5 · Hand off a spec kit — *Feature Kit → OE queue* — (Product)
- **story-product-handoff-with-provenance** — hand off a kit with provenance into the OE queue `M`
- story-product-track-kit-lifecycle — track a kit's lifecycle after handoff `M`

### 6 · Submit a job — *Entry → Confirm* — (OE, all)
- **story-oe-submit-from-queue** — submit a kit from the queue with the right context `M`

*Wireframed as a two-screen pair, not a single SubmitJob screen: **Entry** (the front door — greeting + Job Input Card: intent textarea + attach files/URLs + product selector + "Start job"; a coordinator routes the intent to a workflow or launches Compose) → **Confirm** (a comprehension *and* cost check: the coordinator's paraphrase of your intent ["▸ your exact words" for cross-check] · routed-workflow strip · run config [product · workflow · run-now / schedule / due-by] · story-point-led estimate [points · HITL pauses · cost · time]) → Run. The OE-kit-queue submission folds into this Entry+Confirm pair.*

### 7 · Watch the run — *Jobs* — (OE, PPE)
- **story-job-flow-graph-current-node** — job flow graph with the current node highlighted `M` *(flow-graph widget)*
- **story-job-failure-summary** — "which node failed and why" summary on a failed job `M`
- story-job-intervene-clear-effects — job actions state their effects before confirming `S`
- story-job-cost-time-visibility — live + final cost/time/token spend on a job `S`

*Jobs is the list + status-overview (running / awaiting-approval / completed / failed). The live working view is **Run** (step 8) — reachable both ways: Start job → Run; Jobs list → click a running job → Run.*

### 8 · Inspect agent work — *Run* (NEW screen) — (OE, PPE)
- **story-job-decision-trace-not-firehose** — a decision trace above the raw log stream `L` *(was v1.1+; pulled into v1 — the Run screen realizes it)*
- **story-job-multi-agent-view** — manageable N-agent × M-worktree watch view `M` *(was v1.1+; pulled into v1)*

*Replaces the earlier "the existing basic streaming-log + worktree-diff view is good enough" placeholder. Wireframed as a real screen: a 3-column live-work view with a **polymorphic Artifact Viewer** (code→diff · markdown→rendered · .pen→zoomable canvas · schema→structural changelog), an Artifacts tree, an Agent-Updates event stream with multi-agent chips + inline HITL cards + a persistent steering footer, and a VSCode-like activity bar.*

### 9 · Validate & decide — *Proposals* — (OE, Product)
- **story-review-output-vs-spec-side-by-side** — produced feature side-by-side with its spec `M`
- **story-review-acceptance-criteria-checklist** — shared, diff-linked acceptance-criteria checklist `L` *(checklist widget)*
- **story-review-decision-and-route** — decide accept / reject→flow / reject→Product with audit `M`
- **story-accept-publishes-merge** — accepting a feature authorizes publish-merge `M`
- story-review-automated-checks-prepopulate — automated checks pre-populate the review checklist `M`
- story-review-corrections-payload — reject→flow carries a structured corrections payload `M`

### 10 · Benchmark outcomes — *Benchmarks / BenchmarkRun* — (OE)
- *(out of v1 scope and not yet storied — backbone placeholder. A wireframe now exists ahead of scope: the Benchmarks screen — a runs comparison table [run = model × config × flow; cols score / time / story-pt MAE / $-per-job; ▲ best-per-column markers] with "set as default" promoting a winning config onto a flow → updates Confirm-screen estimates. Design-ahead only; this does not change v1 scope.)*

## Slices

### v1 — walking skeleton  *(20 stories; status: planned; no target date set)*
Smallest end-to-end pipeline: register a product → author + test a flow → spec a kit → hand off → submit a job (Entry → Confirm) → watch it run (Run) → validate & merge. Thin per screen, complete across the whole loop. Backbone step 8 (Sessions) is now its own **Run** screen with the polymorphic Artifact Viewer — `story-job-decision-trace-not-firehose` and `story-job-multi-agent-view` were pulled up from v1.1+ into this slice. Step 10 (Benchmarks) remains out of v1 scope (wireframed design-ahead only).

### v1.1+ — depth  *(15 stories; status: planned)*
Deepen the v1 screens — activation warnings, dry-run, flow versioning, intervention effect-clarity, cost/time visibility, research traceability, wireframe↔spec mapping, spec structure enforcement, kit packaging completeness, embedded generate-* flows, kit lifecycle tracking, automated-checks pre-population, corrections payload, the **Flows** catalog (provenance + validity) and **Agents** browse/enable. Split further via `/product:ux:story-maps:slice` when ready.

## Cross-cutting (not screens — composite components for `packages/design-system`)
- **flow-graph widget** — Compose canvas (edit mode) + Jobs detail (running mode), same component two states. Stories tagged `flow-graph-widget`.
- **acceptance-criteria checklist widget** — Proposals + Feature-Kit review, diff-linked, multi-contributor. Stories tagged `checklist-widget`.
- **polymorphic Artifact Viewer** — Run screen; one component, four render modes by artifact type: code→diff · markdown→rendered-document · .pen→zoomable canvas · schema→structural changelog. Plus the reusable Agent-Updates stream + inline HITL card + persistent steering footer.
- **NavShell** — the hidden nav drawer (☰-toggled, 248px left overlay: Home · Products · Jobs · Benchmarks · —CATALOG— · Agents · Skills · Flows) + the VSCode-like activity bar on Run. Reusable shell across every frame; a design-system concern, not a screen.
- **provenance link** `spec-kit version ↔ job ↔ produced feature` — the data spine every "track status" / side-by-side / audit view hangs off. A controlplane schema concern, not a UI one.

## Screen ↔ wireframe map
Backbone step → screen → frame in `product/design/wireframes/control-plane-v1.pen` (canvas order L→R at y=-1318: Entry → Confirm → Run → Compose → Jobs → Proposals → Intake → Skills → FeatureKit → Agents → Flows → Benchmarks).

| Step | Screen | Frame ID(s) |
|---|---|---|
| 1 Set up a product | Intake — Register Product | `cCWyF` |
| 2 Author & test flows | Compose · Flows (catalog) | `t67st` · `X3pwV9` |
| 3 Browse & enable skills + agents | Skills · Agents | `xxxmB` · `tA1Hn` |
| 4 Spec a feature | Feature Kit | `EhJ27` |
| 5 Hand off a spec kit | Feature Kit (handoff state) → OE queue | `EhJ27` |
| 6 Submit a job | Entry → Confirm | `lmqnz` (+ nav drawer `T5m7q8`) → `C8SxM` |
| 7 Watch the run | Jobs (list/status) | `YJ0XH` |
| 8 Inspect agent work | Run (+ artifact variants) | `MQzvw` · `Kx3SA` md · `B23fO` .pen-canvas · `xqq2j` schema |
| 9 Validate & decide | Proposals | `NNqk8` |
| 10 Benchmark outcomes | Benchmarks *(out of v1; design-ahead)* | `KeO2S` |

## Notes
- The v1 slice traces the *whole* pipeline at minimal depth — a real job can run end-to-end on day one.
- **Design added breadth, not just depth.** The original map predicted a stable screen inventory ("no v1.1+ story introduces a new screen"). Wireframing changed that: SubmitJob split into **Entry + Confirm**, the deferred Sessions placeholder became a full **Run** screen, Catalog was reworked into **Skills** (skillzkit 4-kinds) with **Agents** and **Flows** as sibling nav destinations, and **Benchmarks** was drawn ahead of scope. The map now reflects the realized inventory.
- Per-persona lenses, not duplicate screens: Jobs / Run / Proposals each serve 2+ personas with different intent — one column per screen, stories from multiple personas stacked under it.
- **Reconciled with `product/.pencil-ux.json` (2026-05-16).** The structured twin (`storyMaps[0]` backbone/slices + 35 story objects) now matches this map: the 2 added stories (`story-flows-catalog-and-provenance`, `story-agents-browse-and-enable`) exist as objects, step 6 = `Entry → Confirm`, step 8 = `Run` with `story-job-decision-trace-not-firehose` + `story-job-multi-agent-view` promoted into v1 (now `mvp`-tagged), step 3 = `Skills` (skillzkit 4-kinds, `catalog`→`skills` / `sessions`→`run` screen tags), and slices recounted 20/15. Referential integrity asserted (no dangling refs, slices partition, `mvp` set == v1 slice). Both files are canonical and in sync.
- Next: resume Phase 4 foundation rendering → Phase 5 component generation in `packages/design-system`, building the cross-cutting widgets above first (they recur across the most screens).

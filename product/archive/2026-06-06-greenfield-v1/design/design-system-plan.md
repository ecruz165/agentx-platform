# AgentX Design System — Phase 5 build plan

**Decision (2026-05-16):** build a reusable atomic-component library in
`product/design/design-system.pen` (HeroUI-v3-mapped + AgentX composites), then
**retrofit all 15 wireframe frames** in `control-plane-v1.pen` to instantiate it.
Library is the design source of truth; Phase 5 generates the matching React
components into `packages/design-system/src/components/`.

## Verified architecture
- **Cross-file component refs resolve.** A `{type:"ref", ref:"<id>"}` in
  `control-plane-v1.pen` pointing at a `reusable:true` node in
  `design-system.pen` expands correctly (tested with `Button/Primary` `HhTG5`;
  instance shadow path `<instanceId>/<componentChildId>`). So the library lives
  in its own file and the wireframes instantiate it — no need to co-locate.
- **Override mechanism:** per-instance `descendants: {"<childId>": {…}}` /
  shadow-path updates; unused slots `enabled:false`. Components never forked.
- **Tokens:** library uses the same `mode` (dark/light) theme + variable names
  already in `control-plane-v1.pen` (`$accent`, `$bg-*`, `$text-*`, `$border*`,
  `$status-*`, `$font-sans/mono`) so instances render identically in-place.
  *(Known divergence: the wireframe accent is cyan `#22D3EE`; `.pencil-brand.json`
  ramps are navy. Reconcile the token set before React generation — tracked, not
  blocking the .pen library.)*

## Component inventory

Tiers: **A**=atom, **M**=molecule, **O**=organism/composite (AgentX-bespoke).
"Frames" = which of the 15 wireframes instantiate it (drives retrofit order).

| Component | Tier | HeroUI v3 | Used by frames |
|---|---|---|---|
| Button/{Primary,Secondary,Outline,Ghost,Destructive} | A | Button | all |
| IconButton | A | Button isIconOnly | most |
| Input / Textarea | A | Input / Textarea | Entry, Confirm, Intake, Compose, search bars |
| Select / Dropdown | A | Select / Dropdown | Confirm, Intake, Compose |
| Checkbox / Radio / Switch | A | Checkbox/Radio/Switch | Intake, Benchmarks, Proposals |
| Chip / ContextChip (file·url) | A | Chip | Entry, Confirm, FeatureKit |
| StatusBadge {active,running,failed,awaiting,done,draft} | A | Chip (semantic) | Jobs, Proposals, Intake, FeatureKit, Flows |
| Tabs / SegmentedToggle | A | Tabs | Skills, Run-variants, Benchmarks |
| Avatar / ProfileMenu | A | Avatar | topbar (all) |
| Divider / Kbd / Code | A | Divider/Kbd/Code | many |
| Card (header/content/actions slots) | M | Card | all |
| StatCell / EstimateCard (4-cell) | M | Card | Confirm, Jobs, Benchmarks |
| ListRail (badged list panel) | M | Listbox+Card | Jobs, Proposals, Intake, Skills, FeatureKit, Agents, Flows |
| Breadcrumb / TopCrumb | M | Breadcrumbs | Confirm, Run |
| SearchBar (+ filter pills) | M | Input+Chip | Skills, Agents, Flows, Jobs |
| DataTable (rows/cells, ▲ markers) | M | Table | Benchmarks |
| **TopBar** (☰ · logo · crumb · profile) | O | — | all |
| **NavDrawer** (hidden 248px overlay) | O | — | all (Entry shows open) |
| **ActivityBar** (VSCode icon strip) | O | — | Run + 3 variants |
| **FlowGraph** (status node chain + progress) | O | — | Compose, Jobs *(tag: flow-graph-widget)* |
| **AcceptanceChecklist** (✓auto/✓human/✗/? + diff anchors) | O | — | Proposals, FeatureKit *(tag: checklist-widget)* |
| **ArtifactViewer** (polymorphic) | O | — | Run ×4 (code→diff · md→rendered · .pen→canvas · schema→changelog) |
| **EventFeed** (timestamped agent stream + chips) | O | — | Run, Jobs |
| **HITLCard** (amber agent-needs-you + verdicts) | O | — | Run + schema variant |
| **DiffBlock** (red/green/context lines) | O | — | Run code variant, Proposals |

## Build order (checkpointed batches)
1. **Scaffold + atoms** — library frame sections; Button set, IconButton,
   Input/Textarea, Chip/StatusBadge, Tabs, Avatar, Divider/Kbd/Code. *(checkpoint)*
2. **Molecules** — Card (slots), StatCell/EstimateCard, ListRail, Breadcrumb,
   SearchBar, DataTable. *(checkpoint)*
3. **Organisms (shells)** — TopBar, NavDrawer, ActivityBar. *(checkpoint)*
4. **Organisms (domain)** — FlowGraph, AcceptanceChecklist, ArtifactViewer,
   EventFeed, HITLCard, DiffBlock. *(checkpoint)*
5. **Retrofit frames**, in dependency order — shells first (TopBar/NavDrawer
   touch all 15), then per-frame, one frame per batch with a screenshot diff:
   Entry → Confirm → Run(+3) → Compose → Jobs → Proposals → Intake → Skills →
   FeatureKit → Agents → Flows → Benchmarks. *(checkpoint each frame)*
6. **React generation** — emit `packages/design-system/src/components/*` from the
   library; reconcile cyan↔navy token divergence here.

## Retrofit guarantees
- Per-frame screenshot before/after; structure-only changes (no layout drift).
- One frame per `batch_design`; auto-rollback on failure keeps frames valid.
- Frame names/IDs unchanged so the **Screen ↔ wireframe map** in the story map
  stays accurate.

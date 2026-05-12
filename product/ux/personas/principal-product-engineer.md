# Principal Product Engineer

## Summary
Owns the **general setup** that makes AgentX run for a product — registers the product and its existing repos, configures the default context source, and authors the **Flows** (FlowDefs, including the `publish-*` PR/merge nodes) that job requests run through. The infrastructure layer beneath the other two. One of three pipeline personas: **Product** (the *what*) → **Outcome Engineer** (the *built & validated*) → **Principal Product Engineer** (the *machinery beneath*).

## Role
Owns "general setup". For each product (`productId`): registers it and its existing repos, sets the **default context source** (what `agentx-load` pulls as grounding for the product's agent jobs), and authors / maintains the **FlowDefs** that job requests resolve to — including the `publish-*` nodes that open PRs and merge under the controlplane-issued GitHub App token. Other actors — the Outcome Engineer, automated submitters, or humans via the web UI / `harness-cli` — file job requests against the product; this persona's job is to make sure the right flow and the right context exist to serve them. Keeps the machinery configured so Product can spec and Outcome Engineer can implement.

## Context
Owns one or more `productId`s. Sets a product up once, then evolves its flows and context config as the product's needs change. Works across their own repos and the AgentX console. Senior enough to be trusted with publish/merge flow authoring — under the Gate-2 architecture the controlplane is the credential authority for the GitHub App token those flows use, so flow authorship is a position of trust. Operates in a regulated environment (FERPA / COPPA via SkoolScout): changes to flows and context sources should be attributable.

## Goals
- Register a product and its repos quickly and correctly — repos, credentials, and context config as one coherent setup, in an obvious order.
- Define a default context source that gives agents the right grounding for this product's work.
- Author and iterate on Flows that cover the job-request types the product needs (build, test, review, publish / merge…), with confidence they're correct *before* a real job hits them.
- Trust that an incoming job request resolves to the intended flow with the intended context — and be able to see where flow coverage has gaps.

## Frustrations
- Unclear what "registering a product" actually requires — repos? credentials? context source? — and in what order.
- Context-source setup is opaque: no easy way to confirm the agent is actually seeing the right code / docs.
- Composing and editing FlowDefs is fiddly; there's no good "does this flow even work?" check short of running a real job.
- Hard to see, at a glance, which flows exist for a product, which job-request types they cover, and where the gaps are.

## Tech profile
Senior engineer. Fluent with repos, YAML / config, CI concepts, containers / DevContainers. Wants the console to be a *faster and safer* path to product + flow configuration than hand-editing files — validation and visibility, not hand-holding. Comfortable in a dark, dense, keyboard-friendly UI.

## Screens touched
Intake (product + repo registration) · Compose (flow authoring) · Catalog (skills to wire into flows) · SubmitJob (test a flow) · Jobs / Sessions (their product's jobs) · Proposals (review `publish-*` output).

## Research backing
Hypothesis-based — no formal research yet. Grounded in the builder's own domain knowledge; flag for validation when research becomes possible.

## Notes
(Add ongoing observations, contradictions from research, or nuances as the persona evolves.)

- Resolved (2026-05-12): the model is three roles — **Product** (research/wireframes/feature specs → spec kits), **Outcome Engineer** (submits spec kits to flows + validates the generated features), and this one (general setup: products, repos, context sources, flows). Day-to-day "operator" monitoring (Jobs/Sessions across containers/worktrees) and `publish-*` review are responsibilities folded into this persona and the Outcome Engineer respectively, not separate personas — revisit only if scale forces a split.
- The `publish-*` flow-authoring trust point (Gate-2: controlplane is the credential authority) is *the* reason this is a "Principal" role, not a junior one — flows can open PRs and merge on behalf of the org.

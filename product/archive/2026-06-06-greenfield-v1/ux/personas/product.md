# Product

## Summary
The product person who decides **what** gets built — runs research, produces wireframes, and writes feature specs, bundled as **"spec kits"** that the Outcome Engineer then implements via flows. Lives upstream of any code. One of three pipeline personas: **Product** (the *what*) → **Outcome Engineer** (the *built & validated*) → **Principal Product Engineer** (the *machinery beneath*).

## Role
Owns the "what". Generates research, produces wireframes (`.pen`), and authors feature specs — packaged together as **spec kits**. Hands implementable spec kits downstream to the Outcome Engineer. Does not write production code or configure infrastructure.

## Context
Works upstream of code. Produces artifacts (research, `.pen` wireframes, feature-spec docs) that become the inputs to implementation flows. Collaborates with the Outcome Engineer (who consumes spec kits) and relies on the Principal Product Engineer's setup (products, context sources, flows) for those specs to be runnable. Regulated environment (FERPA / COPPA via SkoolScout) — specs touching user / student data carry compliance constraints that must surface in the spec itself.

## Goals
- Produce clear, well-grounded research, wireframes, and feature specs (spec kits) that an implementer can act on without guessing.
- Keep the chain traceable — research → wireframe → feature spec → the user stories it implies — so nothing gets lost between intent and implementation.
- Iterate on a spec quickly when validation (or the Outcome Engineer) surfaces that it didn't land, without losing the rationale.
- See which features are specced, which are in-flight, and where the spec backlog has gaps.

## Frustrations
- Specs get misinterpreted in implementation; intent is lost in translation.
- No traceability from research to spec to the working feature — can't tell which decision produced which outcome.
- Wireframes drift from specs (and from what actually ships); the spec kit fragments.
- Hard to package research + wireframes + feature spec into one coherent, handed-off artifact instead of scattered docs.

## Tech profile
Strong product / design sensibility; comfortable with structured artifacts, wireframing tools (Pencil / `.pen`), and reading code / diffs at a review level but not authoring them. Wants the console to make a spec kit feel like **one object** — research + wireframes + spec, versioned and traceable — not a folder of loose files.

## Screens touched
A "Specs / Feature Kits" surface (specs in progress, packaged, handed off) · Intake (feature / spec intake) · Catalog (what skills / agents / flows exist, to inform what's feasible) · Proposals (review what implementation produced, against the spec).

## Research backing
Hypothesis-based — no formal research yet. Grounded in the builder's own domain knowledge; flag for validation when research becomes possible.

## Notes
- A "spec kit" should probably mirror the artifacts the skillz `product:ux` / `product:design` suites already produce (`product/.pencil-ux.json` personas/journeys/stories, `.pen` wireframes, feature-spec docs) — so the console's spec-kit object is a packaged, versioned bundle of those, not a new format.
- Open: does this persona work primarily *inside* the controlplane console, or in Pencil + skillz commands with the console just *receiving* finished spec kits? Resolve when mapping the Product user-flows.

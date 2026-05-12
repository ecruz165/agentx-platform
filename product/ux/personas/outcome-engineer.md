# Outcome Engineer

## Summary
Takes product **spec kits** and turns them into **working, validated features** — submits them as job requests against flows, watches the implementation run, and validates the features that come back (accept / reject / iterate). Owns the submit-and-validate loop. One of three pipeline personas: **Product** (the *what*) → **Outcome Engineer** (the *built & validated*) → **Principal Product Engineer** (the *machinery beneath*).

## Role
Owns "did it actually get built, correctly". Takes spec kits from Product, submits them as job requests to the appropriate flow, monitors the implementation job, and validates the resulting feature (the proposal / generated output) against the spec — accept, reject, or send back for another iteration.

## Context
Sits between Product (source of spec kits) and the flows authored by the Principal Product Engineer (the machinery that implements them). Reviews on their own cadence, not real-time. Regulated environment (FERPA / COPPA via SkoolScout): every accept / reject must be attributable and logged; generated features touching user / student data need explicit validation.

## Goals
- Turn a spec kit into a working, validated feature as fast as the loop allows.
- Know quickly whether the agent understood the spec — and where it didn't — without reading every line by hand.
- Validate generated features against explicit, spec-derived criteria (functional, security, regulated-data) and record a clear pass / fail with rationale.
- Iterate efficiently when a feature misses — re-submit with corrections, not start over — and keep an audit trail of attempts.

## Frustrations
- Hard to tell if the agent understood the spec; failures are discovered late, by hand.
- Validation is manual and tedious — no spec-derived checklist, no diff-in-context view, lots of GitHub tab-switching.
- No clear pass / fail criteria carried from the spec into the review; every reviewer improvises.
- Iterating means re-submitting and waiting, with poor visibility into what changed between attempts.

## Tech profile
Engineer who reads code / diffs fluently and runs tests. Wants diff-centric, annotation-friendly review surfaces with provenance (which spec, which flow, which job, which agent) and spec-derived validation checklists. Comfortable in a dark, dense console; keyboard-driven review.

## Screens touched
SubmitJob (submit a spec kit / feature as a job request to a flow) · Jobs / Sessions (watch the implementation job; the live agent work) · Proposals (review + validate the generated feature; accept / reject / iterate) · Benchmarks / BenchmarkRun (validate quality / performance of outcomes) · Catalog (which flows / agents are available to submit against).

## Research backing
Hypothesis-based — no formal research yet. Grounded in the builder's own domain knowledge; flag for validation when research becomes possible.

## Notes
- The "validation" half of this role is under-served by the current page list — Proposals covers *reviewing* a diff, but spec-derived pass/fail checklists, attempt-to-attempt comparison, and the audit trail of accept/reject decisions may need their own surface. Flag when mapping the Outcome Engineer user-flows.
- Relationship to Product: a rejected feature should round-trip back to Product (spec was wrong/unclear) vs. back to the flow (implementation missed a correct spec) — the console should make that fork explicit.

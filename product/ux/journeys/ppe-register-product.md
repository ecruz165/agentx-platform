# Register a product

## Summary
Principal Product Engineer brings a product into AgentX: name + `productId`, attach existing repos, configure the default context source, activate. This is the **setup prerequisite** for any job request — nothing runs against a product that hasn't been registered.

## Type
user-flow

## Personas
- [Principal Product Engineer](../personas/principal-product-engineer.md)

## Steps

### 1. Start product registration
- **User actions:** Open Intake → "New product"; enter product name; choose or accept a `productId` (slug).
- **System:** Creates a draft product record; prompts for repos next; shows the setup checklist (repos → context → activate).
- **Touchpoints:** Intake screen.
- **Pain:** `pain-product-setup-requirements-unclear` — unclear what registration requires, and in what order *(moderate, always)*.

### 2. Attach existing repos
- **User actions:** Connect one or more existing repos (`org/repo` or URL); pick a default branch per repo; authorize the GitHub App on the org if not already installed.
- **System:** Validates repo access via the GitHub App; records repos + default branches; surfaces access errors inline.
- **Touchpoints:** Intake screen; GitHub App authorization flow.
- **Pain:** `pain-github-app-auth-opaque` — can't tell if the App has access to a given private repo *(major, frequently)* · `pain-no-repo-access-test` — no way to test repo access before saving *(moderate, sometimes)*.

### 3. Configure the default context source
- **User actions:** Define what `agentx-load` pulls as grounding (paths/globs, docs, prior context); pick a context strategy/scope; preview the resolved context (files + token estimate).
- **System:** Resolves the context source; renders a preview of what would be loaded (file list + token count); warns if over budget.
- **Touchpoints:** Intake screen; context-source config panel.
- **Pain:** `pain-context-source-opaque` — no preview of the resolved context, so you can't confirm the agent will see the right code/docs *(major, always)* · `pain-context-budget-unclear` — unclear how much context is too much *(moderate, sometimes)*.

### 4. Confirm & activate the product
- **User actions:** Review the assembled product (name, `productId`, repos, context source); activate it.
- **System:** Marks the product active; job requests can now target it; prompts "no flows yet → author a flow" linking to the author-flow path.
- **Touchpoints:** Intake screen → product detail.
- **Pain:** `pain-active-product-no-flows` — a product can be activated with zero flows, so job requests against it just fail *(moderate, sometimes)*.

## Pain points
6 registered — 2 major, 4 moderate. See `product/.pencil-ux.json` `painPoints` and `/product:ux:journeys:pain-points`.

## Notes
- Open: is `productId` user-chosen or system-assigned? Affects step 1's UX (free-text vs. read-only).
- Open: should step 4 *block* activation with zero flows, or just warn? Leaning warn (you might register a product and author flows later) — but a never-runnable product is a footgun.
- The GitHub App authorization in step 2 is the same credential authority that `publish-*` flow nodes use (Gate-2) — registering repos and being able to merge to them are the same trust grant.

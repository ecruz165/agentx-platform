# Flow Designer — PRD v1.0

**Status:** Locked (2026-05-07) — types implemented in `packages/harness-core/src/catalog.ts`; runtime pending
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold
**Companion documents:**
- `2026-05-06-prd-job-state-machine.md` — JobStateMachine that *executes* flows (now refers to FlowDef instead of the prior PipelineStep tree). Sections covering step-kind taxonomy in that PRD are superseded by this one.
- `2026-05-06-prd-catalog-service.md` — Catalog module that stores FlowDefs (validator now references this PRD's node + edge rules)
- `2026-05-06-prd-control-plane.md` — umbrella for the Spring Modulith app
- `2026-05-07-prd-intent-service.md` — IntentService consumes JobDefinitionFlow output
- `packages/harness-core/src/catalog.ts` — canonical implementation of the types in §"Internal type surface"

---

## Core principle

**One canvas primitive. Edges carry logic. Behavior composes via tags.**

The user drags exactly one block. All routing lives on edges, all behavior modifiers are tags, all reliability concerns are policies. The graph the user draws maps 1:1 to LangGraph node + conditional-edge execution.

---

## The Node — `TaskStep` (Agent)

Polymorphic via a `kind` discriminator:

| `kind` | Purpose |
|---|---|
| `agent` | LLM-driven execution (default) |
| `tool` | Deterministic tool/API call |
| `script` | Code execution |
| `transform` | Data shaping |
| `gate` | Quality gate — runs assertions, emits `pass` / `reject` |
| `subflow` | Invoke another flow |
| `trigger` | Entry point (webhook, schedule, manual, event, message) |

Card surface displays: agent name, role, execution status, active tag badges. All detailed config (prompts, tools, I/O, policy, gate assertions) lives in the contextual side panel.

---

## The Edges

Edges carry **all** routing logic. There are no `If`, `Split`, `Merge`, or `Branch` nodes.

| Edge type | Visual | Semantics |
|---|---|---|
| **Sequence** | solid line | Default forward path |
| **Conditional** | solid + inline label `if x > 5` | Predicate-gated path |
| **Parallel split** | multiple outgoing from one node | Fire all simultaneously |
| **Parallel join** | multiple incoming into one node | Configurable on receiver: `all` (default) / `any` / `n-of-m` |
| **Fallback** | dashed line | Taken when upstream fails per policy |
| **Error** | red, distinct | Implicit per node; wired only when explicitly handled |
| **Reject** | amber / dashed | Emitted from `Approval` or `kind:'gate'`. Carries rejection payload. User-routable (see Rejection Mechanics) |

Join strategy is set on the receiving node's incoming-edge config — not on a separate Merge node.

**Error vs Reject:** error = node failed to execute (exception, timeout, infrastructure). Reject = node executed successfully but produced a "no" outcome (human declined, gate assertion failed). Different edges, different payloads, different recovery patterns.

---

## The Tags (Badges)

Behavioral modifiers stacked on a TaskStep. Visually distinct icons; multiple tags allowed.

| Tag | Icon | Behavior |
|---|---|---|
| **Approval** | lock / avatar | HITL gate. Role-based assignment, pessimistic concurrency lock, steering context injection, SLA timeout. Emits `approve` (sequence) and `reject` edges. |
| **Suspend** | hourglass / lightning | Durable execution checkpoint. Serializes graph state, kills the active worker, hydrates a new worker on timer expiration or external signal. |
| **Loop** | stacked cards / refresh | Iterates the node over a collection or directory. `mode: sequential | parallel`, optional `concurrency` cap. |

**Stacking rules:**
- `Loop` composes with anything. `Loop + Approval` = approval per iteration. `Loop + Suspend` = durable iteration checkpoint.
- `Approval` and `Suspend` are mutually exclusive on the same node — Approval already implies suspension with SLA.
- Render order on the card: `Loop` (top-left), `Approval` or `Suspend` (top-right).

---

## Rejection Mechanics

`Approval` and `kind:'gate'` are the only nodes that emit a reject edge. The reject edge is **explicit and user-wired** — no automatic retry behavior.

**Routing destinations:**

| Reject edge wired to... | Semantic |
|---|---|
| Same upstream node | Retry-with-steering (the common case) |
| Different node | Remediation / fix-it agent |
| An `Approval` node | Escalate to human review |
| Unwired | Flow fails per node `onError` policy |

**Payload carried by reject edges:**

```typescript
type RejectionPayload = {
  reason: string;
  steering?: string;        // injected by reviewer (Approval) or assertion message (gate)
  findings?: unknown;       // structured gate output
  attempt: number;          // 1-indexed, incremented on each loop
};
```

This payload becomes input context to the destination node, enabling retry-with-context.

**Bounded loops:** the reject edge is the only place a loop can be unbounded (`Loop` tag is bounded by collection size; all other edges form a DAG). Therefore reject edges carry attempt limits:

```typescript
type RejectEdge = {
  from: NodeId;
  to: NodeId;
  type: 'reject';
  maxAttempts?: number;            // default 3
  onMaxAttempts?:
    | { kind: 'fail' }
    | { kind: 'escalate'; to: NodeId };  // typically points to an Approval node
};
```

**Canonical pattern:** `agent → gate → reject` loops back to agent with `maxAttempts: 3, onMaxAttempts: { kind: 'escalate', to: 'tech-lead-approval' }`.

---

## Boundaries

- **Trigger** — explicit, `kind:'trigger'` on TaskStep. Exactly one per flow. Subtype: `webhook | schedule | manual | event | message`.
- **End** — implicit. Any node with no outgoing edges is terminal. Status set on the node's `terminal` field; defaults to `success`.

---

## Subflows & multi-step iteration

Multi-step iteration ("for each ticket: lint → test → deploy") is a `kind:'subflow'` TaskStep with a `Loop` tag. The subflow encapsulates the steps; the Loop tag iterates. This preserves the one-primitive promise.

Subflow nodes render with a distinct visual (stacked card or expandable) so users can drill in.

---

## Error handling

Two layers, separated by visibility:

1. **Policy** (config, side panel) — `policy: { retry, timeout, onError }` on every TaskStep.
2. **Topology** (visible) — error edges. If wired, errors route there. If unwired, errors propagate per `onError`.

There is no `Try`, `Catch`, `Retry`, or `Timeout` node. All are properties or edges.

---

## Palette UX

**Single block:** `Agent` — drag onto canvas, configure `kind` in side panel.

**Tags tray:** `Approval`, `Suspend`, `Loop` — drag onto an existing block.

**Trigger affordance:** "Start here" button auto-places a `kind:'trigger'` node when canvas is empty.

**The gut-check sentence test:**
> "When a PR opens, run an Agent to lint. If it passes, Split into tests and security scan, Merge the results, get Approval from the tech lead, then Loop over the tickets to deploy."

If users can describe their flow in this register without translation, the language is working.

---

## Internal type surface

The canonical implementation lives in `packages/harness-core/src/catalog.ts`. Key shapes:

```typescript
type FlowNode = TaskStep;  // single primitive

type TaskStep = {
  id: string;
  kind: 'agent' | 'tool' | 'script' | 'transform' | 'gate' | 'subflow' | 'trigger';
  config:
    | AgentConfig
    | ToolConfig
    | ScriptConfig
    | TransformConfig
    | GateConfig
    | SubflowConfig
    | TriggerConfig;
  tags?: {
    approval?: ApprovalTag;
    suspend?: SuspendTag;
    loop?: LoopTag;
  };
  policy?: {
    retry?: RetryPolicy;
    timeout?: Duration;
    onError?: 'propagate' | 'continue' | 'fallback';
  };
  joinStrategy?: 'all' | 'any' | { nOfM: number };  // default 'all'
  terminal?: 'success' | 'fail';   // applied when node has no outgoing edges
};

type Edge =
  | { from: NodeId; to: NodeId; type: 'sequence' }
  | { from: NodeId; to: NodeId; type: 'conditional'; condition: Expression }
  | { from: NodeId; to: NodeId; type: 'fallback' }
  | { from: NodeId; to: NodeId; type: 'error' }
  | {
      from: NodeId;
      to: NodeId;
      type: 'reject';
      maxAttempts?: number;
      onMaxAttempts?: { kind: 'fail' } | { kind: 'escalate'; to: NodeId };
    };

type ApprovalTag = {
  assigneeRole: string;
  slaMs: number;
  steeringInputs?: SteeringInputSchema;
  concurrency: 'pessimistic';
};

type SuspendTag = {
  trigger:
    | { kind: 'timer'; durationMs: number }
    | { kind: 'event'; eventType: string; matcher?: Expression };
};

type LoopTag = {
  source: 'collection' | 'directory';
  path: Expression;          // resolves to iterable
  mode: 'sequential' | 'parallel';
  concurrency?: number;
};

type Expression =
  | { kind: 'jsonpath'; path: string }
  | { kind: 'js'; expression: string }
  | { kind: 'literal'; value: unknown };

type RejectionPayload = {
  reason: string;
  steering?: string;
  findings?: unknown;
  attempt: number;
};

type FlowDef = {
  id: string;
  description?: string;
  kind?: 'work' | 'job-definition' | 'post-job';
  output?: FlowOutputContract;
  nodes: TaskStep[];
  edges: Edge[];
};
```

---

## What this design eliminates

11+ candidate node types collapse into 1 primitive. `IfBranch`, `Split`, `Merge`, `Wait`, `Event`, `Retry`, `Timeout`, `Try`, `Catch`, `Fail`, `Succeed`, `Call`, `Approval-as-node`, `QualityGate-as-node` — all expressed as edges, tags, policies, or `kind` variants.

The user's mental model: *Agents do work, edges connect them, tags modify behavior, gates and approvals can reject.* That's the whole grammar.

---

## Validator rules (catalog enforcement)

Implemented in `validateFlow` in `catalog.ts`:

1. **Trigger uniqueness**: exactly one node with `kind: 'trigger'`. No incoming edges. ≥1 outgoing edge.
2. **Edge referential integrity**: every `from`/`to` references a known node id.
3. **Edge cardinality**: at most one of each `error`, `fallback`, `reject` per source node. Multiple `sequence` and `conditional` outgoing OK (the parallel-split mechanism). Multiple incoming OK (parallel join, with `joinStrategy` on receiver).
4. **Reject-source restriction**: `reject` edges may only originate from `kind: 'gate'` nodes or nodes with the `Approval` tag.
5. **Cycle detection**: only reject edges may form cycles. The (sequence | conditional | fallback | error) sub-graph must be a DAG.
6. **Tag mutual exclusion**: `Approval` and `Suspend` cannot coexist on the same node.
7. **JobDefinitionFlow output contract**: flows with `kind: 'job-definition'` must declare `output: { kind: 'job-intent' }`.
8. **`onMaxAttempts.escalate.to`**: must reference a known node id.

---

## Workspace shorthand

For developer ergonomics, `workspace-template/.harness/config/flows.json` accepts a `phases` shorthand alongside the canonical `nodes`+`edges` shape. The `readWorkspaceFlows` loader auto-expands phases into a linear chain:

```jsonc
{
  "id": "feature-add",
  "phases": [
    { "id": "planner", "agent": "claude-sdk", "description": "Plan", "systemPrompt": "..." },
    { "id": "implementer", "agent": "claude-sdk", "description": "Implement", "systemPrompt": "..." }
  ]
}
```

Becomes (after loader expansion):

```jsonc
{
  "id": "feature-add",
  "nodes": [
    { "id": "__trigger", "kind": "trigger", "config": { "kind": "manual" } },
    { "id": "planner", "kind": "agent", "config": { "agent": { "id": "planner", "role": "Plan", "adapter": "claude-sdk", "systemPrompt": "..." } } },
    { "id": "implementer", "kind": "agent", "config": { "agent": { "id": "implementer", "role": "Implement", "adapter": "claude-sdk", "systemPrompt": "..." } } }
  ],
  "edges": [
    { "from": "__trigger", "to": "planner", "type": "sequence" },
    { "from": "planner", "to": "implementer", "type": "sequence" }
  ]
}
```

Phases are a *one-way convenience*: the loader expands them on read; the canonical stored shape is `nodes`+`edges`. Phases shorthand can't express branching, gates, approvals, loops, or any other non-trivial shape — switch to canonical when you need them.

---

## Implementation status (2026-05-07)

| Layer | State |
|---|---|
| TypeScript types in `harness-core/src/catalog.ts` | ✅ Locked |
| Validator (`validateFlow`, `validateNode`, `validateEdge`, all supporting validators) | ✅ Implemented |
| `walkAgents(flow)` graph traversal | ✅ Implemented |
| Test coverage in `harness-core/src/catalog.test.ts` (18 tests) | ✅ Passing |
| Workspace YAML loader (`harness-server/src/load-catalog.ts`) supporting `phases` shorthand + canonical | ✅ Implemented |
| Demo catalog in `harness-cli/src/in-process-run.tsx` using `flowFromAgents()` | ✅ Implemented |
| REST API (`/v1/catalog/flows`, `/v1/catalog/flows/:id`) | ✅ Implemented |
| Workspace template (`.harness/config/flows.json` with phases shorthand) | ✅ Implemented |
| Runtime: orchestrator that walks the flow graph, dispatches per-node, applies tags, handles reject edges with attempt counters | ⏳ **Pending** — currently `runJob` walks a flat agent list extracted via `walkAgents`; needs replacement with proper graph executor (mapping to LangGraph StateGraph is the natural target) |
| LangGraph mapping | ⏳ Pending |
| Web UI canvas (palette, drag-drop, tags tray, trigger affordance) | ⏳ v1 — see `prd-control-plane-web-ui.md` |
| 5 harness-server test suites (registration, coordinator-auto-route, entry-coordinator, orchestrator-integration, load-catalog) | ⏳ Stubbed with `describe.skip`; need fixture rebuild from `pipelines: [{steps:...}]` to flow shape |

---

## Decisions Log

| ID | Decision | Rationale | Date |
|---|---|---|---|
| D1 | Graph + edges + tags model over tagged-union step tree | Maps 1:1 to LangGraph; cycles are first-class; UX is one-block-drag instead of pick-from-N kinds | 2026-05-07 |
| D2 | Reject vs error split | Agentic failures are mostly "the LLM/human/gate said no" not "an exception was thrown"; routing + payload differ | 2026-05-07 |
| D3 | Approval and Conditional as modifiers/edges, not step kinds | Both are gates on other work, not work themselves; composition is cleaner | 2026-05-07 |
| D4 | Trigger as a node kind (not separate concept) | Sits in the same `nodes: TaskStep[]` array; uniqueness constraint enforced by validator | 2026-05-07 |
| D5 | Edge cardinality: at most one error/fallback/reject per source | Atomic semantics; multi-way rejection routes through `findings` payload + downstream conditional edges | 2026-05-07 |
| D6 | `joinStrategy` on receiving node, not on incoming edges | Single source of truth; receiver decides combine semantics | 2026-05-07 |
| D7 | Only reject edges may form cycles | Retry-with-context is the canonical loop; other cycles indicate design errors and are rejected by validator | 2026-05-07 |
| D8 | Expression as a tagged union (`jsonpath` | `js` | `literal`) | Future-proof for adding evaluators (e.g., `jsonata`) without breaking change | 2026-05-07 |
| D9 | Loop as a tag iterating a single node, not a step kind with body | Multi-step iteration handled via `kind: 'subflow'` + `Loop` tag — preserves one-primitive promise | 2026-05-07 |
| D10 | Phases shorthand survives in workspace YAML loader | Developer ergonomics for the common case (linear chain of agents) | 2026-05-07 |

---

## Phased delivery

| Phase | Scope |
|---|---|
| **Phase 1 — Types** ✅ | TaskStep + Edge + tags + supporting types in catalog.ts |
| **Phase 2 — Validator** ✅ | Full structural + semantic validation including cycle detection |
| **Phase 3 — Loader** ✅ | Workspace `flows.json` loader with phases shorthand expansion |
| **Phase 4 — Runtime: in-process executor** | Replace current flat-agent `runJob` with graph walker; map to LangGraph StateGraph; handle sequence + conditional edges |
| **Phase 5 — Runtime: tags** | Apply Approval (HITL pause), Loop (per-node iteration), Suspend (durable checkpoint) |
| **Phase 6 — Runtime: error/reject paths** | Wire error + reject edges through orchestrator with attempt-counter enforcement |
| **Phase 7 — Web UI canvas** | Palette + drag-drop + side panel + tags tray + trigger affordance |
| **Phase 8 — Test rebuild** | Restore the 5 stubbed harness-server suites with new fixture shape |

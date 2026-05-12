# Watch the implementation run

## Summary
Outcome Engineer monitors a running job: open it (flow graph, current node) → inspect live agent work (Sessions: streaming logs, worktree diffs, agent state) → intervene if needed (stop / retry node / re-submit) → see the outcome summary when it completes. Shares its shape with the Principal Product Engineer's [test-flow](./ppe-test-flow.md).

## Type
user-flow

## Personas
- [Outcome Engineer](../personas/outcome-engineer.md) · [Principal Product Engineer](../personas/principal-product-engineer.md)

## Steps

### 1. Open the running job
- **User:** From Jobs (or the submit confirmation), open the job → its flow graph with the current node highlighted.
- **System:** Live node status; the flow graph; elapsed time; current cost/token spend.
- **Touchpoints:** Jobs screen; job detail.
- **Pain:** `pain-job-stuck-or-slow` — which node, stuck or slow? *(major, frequently)*.

### 2. Inspect live agent work
- **User:** Open Sessions for the job; read streaming agent logs; view worktree changes as they happen; optionally watch multiple agents/worktrees side by side.
- **System:** Streaming logs per agent; per-worktree diff; agent state (thinking / tool-calling / done).
- **Touchpoints:** Sessions screen.
- **Pain:** `pain-log-firehose` — hard to see what the agent *decided* vs. raw output *(major, frequently)* · `pain-multi-agent-view-overwhelms` — N agents × M worktrees overwhelms one view *(moderate, sometimes)*.

### 3. Intervene if needed
- **User:** If a job is stuck/wrong — stop the job, retry a failed node, or adjust & re-submit.
- **System:** Applies the action; records it (who, when, why); for retry, re-runs from the failed node.
- **Touchpoints:** Jobs screen → job actions.
- **Pain:** `pain-intervention-effects-unclear` — unclear what stop/retry/re-submit will do; destructive? *(moderate, sometimes)*.

### 4. Job completes — see the outcome summary
- **User:** When the job finishes/fails, see the outcome summary: produced artifacts (proposal/diff, PR if any), per-node outcomes, total cost/time, "which node failed and why" if failed.
- **System:** The summary view; links to the produced feature for validation.
- **Touchpoints:** Jobs → job detail.
- **Pain:** `pain-failure-reason-buried` — failure reasons buried in logs; no per-node summary *(major, frequently)*.

## Pain points
5 distinct (3 new) — 3 major, 2 moderate.

## Notes
- The flow graph with a highlighted current node is the spine of this screen — it ties the abstract FlowDef (from [author-flow](./ppe-author-flow.md)) to the live execution. Same widget the Compose canvas uses, in "running" mode.
- `pain-log-firehose` is the deepest one here: an agent log stream is mostly tool-call noise; what the watcher needs is a *decision trace* (the agent chose X because Y), surfaced above the raw stream. That's a design problem the Sessions screen has to solve, not just a "tail -f" view.
- This flow is shared near-verbatim with the PPE's test-flow steps 2–3 — same screens, different intent (OE: "is my feature getting built?", PPE: "does my flow work?"). Story map encodes one backbone column, two persona stories.

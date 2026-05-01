# Agentic Harness Review Findings — Codex

**Status:** Review findings
**Date:** 2026-05-01
**Author:** Codex
**Scope:** Critical review of the agentic harness design, implementation plan, and related PRDs in `.plans/`

## Reviewed documents

- `2026-04-30-agentic-harness-design.md`
- `2026-04-30-agentic-harness-ecosystem-prd.md`
- `2026-04-30-agentic-harness-implementation-plan.md`
- `2026-04-30-prd-agent-adapter-lib.md`
- `2026-04-30-prd-agentic-worker-lib.md`
- `2026-04-30-prd-auth-lib.md`
- `2026-04-30-prd-edge-context-server.md`
- `2026-04-30-prd-edge-memory-server.md`
- `2026-04-30-prd-harness-cli.md`
- `2026-04-30-prd-harness-core.md`
- `2026-04-30-prd-harness-server.md`
- `2026-04-30-prd-token-codecs-lib.md`
- `2026-04-30-prd-vscode-extension.md`
- `2026-04-30-prd-workspace-setup-cli.md`
- `2026-04-30-prd-workspace-template.md`

## Findings

### 1. Critical: the v1 worker/runtime architecture is internally inconsistent

The docs describe incompatible v1 execution models:

- The design doc and implementation plan position the multi-job runtime as post-v1 or optional, with v1 centered on an in-process worker model.
- The harness-server PRD requires one ephemeral DevContainer per job and explicitly says there is no in-process worker pool.
- The same harness-server PRD later describes the queue as if v1 uses an in-process pool.
- The workspace template and worker-lib both assume the DevContainer-per-job model is already the primary v1 path.

Primary refs:

- `2026-04-30-agentic-harness-design.md:63`
- `2026-04-30-agentic-harness-design.md:1477`
- `2026-04-30-agentic-harness-implementation-plan.md:97`
- `2026-04-30-agentic-harness-implementation-plan.md:802`
- `2026-04-30-prd-harness-server.md:70`
- `2026-04-30-prd-harness-server.md:73`
- `2026-04-30-prd-harness-server.md:201`
- `2026-04-30-prd-workspace-template.md:23`

Impact:

- This is not editorial drift. It changes queue semantics, failure handling, heartbeat design, spawn lifecycle, testing, and what “v1” actually is.

### 2. Critical: the implementation plan freezes public types before the design is resolved

The implementation plan says Layer 1 locks the complete public type surface and later layers do not change it. The design doc still marks a large set of public-contract decisions as unresolved, including runtime packaging, MCP depth, credential broker behavior, pipeline catalog shape, admission control, and several policy boundaries. Downstream PRDs also already depend on new capability fields that are not yet part of the locked surface.

Primary refs:

- `2026-04-30-agentic-harness-implementation-plan.md:31`
- `2026-04-30-agentic-harness-implementation-plan.md:46`
- `2026-04-30-agentic-harness-design.md:3`
- `2026-04-30-agentic-harness-design.md:1404`
- `2026-04-30-agentic-harness-design.md:1453`
- `2026-04-30-agentic-harness-design.md:1477`
- `2026-04-30-prd-token-codecs-lib.md:645`

Impact:

- The plan’s “no-regret” contract is not credible yet. Either the design must be resolved first, or Layer 1 cannot honestly promise stable interfaces.

### 3. Critical: product-scoped job submission is mandatory in the backend but missing from the client UX

The workspace/template/server model requires every job to be submitted against a `productId`. That field is required by the server and determines which repos/worktrees mount into the worker. But the documented CLI and VS Code submit flows do not ask for or infer product selection, and the example `POST /v1/jobs` body omits it entirely.

Primary refs:

- `2026-04-30-prd-workspace-template.md:75`
- `2026-04-30-prd-harness-server.md:57`
- `2026-04-30-prd-harness-server.md:230`
- `2026-04-30-prd-workspace-setup-cli.md:25`
- `2026-04-30-prd-workspace-setup-cli.md:206`
- `2026-04-30-prd-vscode-extension.md:62`
- `2026-04-30-prd-vscode-extension.md:163`

Impact:

- A user cannot reliably submit a valid job from the documented client surfaces.
- This also blocks automation and external integrations because the API examples are incomplete.

### 4. High: the v1 auth and identity posture is inconsistent across surfaces

The server and edge-server PRDs defer application-level auth, per-user quotas, and identity to v1.x. But other docs still describe API keys, mtauth sign-in, per-user quotas, and token-like admin affordances as if they are active concerns in v1.

Primary refs:

- `2026-04-30-prd-harness-server.md:81`
- `2026-04-30-prd-harness-server.md:93`
- `2026-04-30-prd-harness-server.md:393`
- `2026-04-30-prd-harness-server.md:47`
- `2026-04-30-prd-vscode-extension.md:101`
- `2026-04-30-prd-vscode-extension.md:163`
- `2026-04-30-prd-edge-context-server.md:121`
- `2026-04-30-prd-edge-context-server.md:311`
- `2026-04-30-prd-edge-memory-server.md:100`

Impact:

- The docs do not present one coherent operator story.
- Client setup flows risk implementing auth UX the server explicitly does not support in v1.

### 5. High: `token-codecs` depends on adapter capabilities and tool-injection behaviors that the adapter PRD does not provide

The token-codecs PRD assumes:

- `tool-use` forcing works on `claude-code-cli` and `opencode-cli`
- `supportsJsonMode` exists on adapter capabilities
- the host can inject a forced `submit_result` tool into relevant adapters

The adapter PRD says CLI adapters expose built-in tools for observability only and hosts cannot inject custom tool definitions there. It also does not define `supportsJsonMode` in the capability contract.

Primary refs:

- `2026-04-30-prd-token-codecs-lib.md:55`
- `2026-04-30-prd-token-codecs-lib.md:511`
- `2026-04-30-prd-token-codecs-lib.md:518`
- `2026-04-30-prd-token-codecs-lib.md:645`
- `2026-04-30-prd-agent-adapter-lib.md:239`
- `2026-04-30-prd-agent-adapter-lib.md:347`
- `2026-04-30-prd-agent-adapter-lib.md:398`

Impact:

- The schema-lifecycle strategy selection is not implementable as written.
- A dependent library is already forcing changes into the supposedly stable adapter contract.

### 6. High: MCP is simultaneously a v1 capability and an ecosystem-wide prohibition

The top-level design still includes an MCP client path in v1 via `McpClientProvider`. Several other PRDs declare MCP banned by policy, actively suppressed, and out of scope forever, including adapter-level suppression and config rejection.

Primary refs:

- `2026-04-30-agentic-harness-design.md:59`
- `2026-04-30-agentic-harness-design.md:1454`
- `2026-04-30-agentic-harness-design.md:1670`
- `2026-04-30-prd-agent-adapter-lib.md:40`
- `2026-04-30-prd-harness-core.md:49`
- `2026-04-30-prd-edge-memory-server.md:107`
- `2026-04-30-prd-edge-context-server.md:19`

Impact:

- This is a hard architecture fork.
- It affects package layout, registry semantics, capability definitions, and roadmap sequencing.

### 7. Medium: the ecosystem index and harness CLI PRD are incomplete enough to be unusable as planning artifacts

The ecosystem PRD and harness CLI PRD are visibly truncated. The ecosystem index also references a non-existent worker-lib filename with a `2026-05-01` date while the actual file present is dated `2026-04-30`.

Primary refs:

- `2026-04-30-agentic-harness-ecosystem-prd.md:27`
- `2026-04-30-agentic-harness-ecosystem-prd.md:46`
- `2026-04-30-prd-harness-cli.md:21`

Impact:

- These docs cannot currently act as reliable inputs for implementation sequencing or consumer UX planning.

### 8. Medium: the capture retrieval contract is inconsistent and not client-safe

The harness-server PRD says `GET /v1/jobs/{id}/captures` returns signed URLs, but the technical approach says v1 actually returns local `file://` URLs until v1.x adds S3. The response example still shows HTTPS signed URLs. A `file://` inside a DevContainer is not a portable contract for VS Code or remote consumers.

Primary refs:

- `2026-04-30-prd-harness-server.md:116`
- `2026-04-30-prd-harness-server.md:197`
- `2026-04-30-prd-harness-server.md:280`
- `2026-04-30-prd-vscode-extension.md:17`

Impact:

- The documented API shape is misleading.
- Client surfaces that “inspect captures” do not have a stable retrieval mechanism.

### 9. Medium: the schedule looks materially under-estimated relative to the component estimates

The implementation plan claims roughly 12 weeks for a focused 1–2 person team. But the explicit work estimates for the major ecosystem pieces are already substantial on their own, especially once integration and rework are counted. The edge-context-server estimate alone is large enough to dominate its slot in the proposed overlap schedule.

Primary refs:

- `2026-04-30-agentic-harness-implementation-plan.md:26`
- `2026-04-30-agentic-harness-implementation-plan.md:981`
- `2026-04-30-prd-edge-context-server.md:506`
- `2026-04-30-prd-harness-server.md:446`
- `2026-04-30-prd-workspace-template.md:420`
- `2026-04-30-prd-workspace-setup-cli.md:297`
- `2026-04-30-prd-vscode-extension.md:271`

Impact:

- The schedule currently reads more like an optimistic target than an execution-ready plan.

## Open questions that should be resolved before implementation starts

1. What is the actual v1 worker model?
2. Is MCP banned ecosystem-wide, or only on the peer servers?
3. How is `productId` supposed to enter submit flows across CLI, VS Code, and external clients?
4. Is v1 truly unauthenticated local-only, or are any client surfaces expected to ship auth UX now?
5. Are Layer 1 types allowed to move after the Layer 0 spike, or must the unresolved design questions be closed before Layer 1 begins?

## Bottom line

The main problem is not missing detail; it is cross-document divergence after several architecture pivots. The worker/runtime model, product-scoped submission, auth posture, and MCP policy should be normalized before treating the interfaces or milestone plan as stable.

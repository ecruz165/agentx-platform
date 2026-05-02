# agentx

Monorepo for the Agentic Harness Ecosystem. See `.plans/` for the architecture
design, ecosystem PRD, per-component PRDs, and four critical reviews.

## Two trees in this monorepo

| Tree | Purpose | Consumed by |
|---|---|---|
| `packages/*` | Source for the npm packages we ship (`@agentx/*`) | DevContainers in workspace-template; users directly via npm |
| `workspace-template/` | Cloneable artifact `harness init` bootstraps onto a user's machine (per `prd-workspace-template.md`) | `harness init` (`workspace-setup-cli`) |

The two trees communicate via versioned npm packages. During development, the
workspace-template uses local file refs into `packages/`.

## Locked architecture decisions (2026-05-01)

| # | Decision | Where it's enforced |
|---|---|---|
| 1 | DevContainer-per-job, named container `agentx-job-<jobId>`, N agents inside, M worktrees per agent | `workspace-template/` (MVP-1+) |
| 2 | MCP banned ecosystem-wide | `packages/agent-adapter` enforces at adapter spawn (3-layer suppression) |
| 3 | v1 adapters: Claude SDK + OpenCode CLI only | `packages/agent-adapter` |
| 4 | `productId` required in submit; CLI session-state | `packages/harness-cli` enforces |
| 5 | UDS file-perm trust only in v1 | `packages/auth-lib` (auth file) + `packages/harness-cli` (sockets) both gate `0600` |

## Package map

| Package | Maps to PRD | What it does today |
|---|---|---|
| `@agentx/auth-lib` | `prd-auth-lib.md` | Credential types, `FileBroker` with `0600` gate, `AuthStore`, GitHub Device Flow + Copilot session-token exchange + `callCopilot()` |
| `@agentx/agent-adapter` | `prd-agent-adapter-lib.md` | `ClaudeSdkAdapter`, `OpenCodeCliAdapter`, capture pipeline |
| `@agentx/harness-server` | `prd-harness-server.md` | HTTP-over-UDS echo server (real orchestration in MVP-3+) |
| `@agentx/edge-memory-server` | `prd-edge-memory-server.md` | HTTP-over-UDS echo server (real impl in MVP-2+) |
| `@agentx/edge-context-server` | `prd-edge-context-server.md` | HTTP-over-UDS echo server (real impl in MVP-2+) |
| `@agentx/harness-cli` | `prd-harness-cli.md` | `harness auth/server/session/memory/context …` CLI |

## Path conventions (load-bearing for MVP-1 readiness)

These match `prd-workspace-template.md` so MVP-1's container work is just
adding bind-mounts, not relocating files.

| Path | Scope | What it holds |
|---|---|---|
| `~/.agentx/auth.json` | Per-user (host) | Credentials, mode `0600` |
| `~/.agentx/session.json` | Per-user (host) | CLI session state (productId etc.), mode `0600` |
| `<workspace>/.harness/run/<service>.sock` | Per-workspace | UDS sockets, mode `0600`. Bind-mounts to `~/.harness/run/` in containers (MVP-1+) |
| `<workspace>/.harness/wt/<jobId>/<subagentId>/<repoName>/` | Per-job | Worktrees per F25 schema (MVP-2+) |
| `<workspace>/.harness/captures/` | Per-workspace | Capture sink (also at MVP-0 for examples) |
| `<workspace>/.harness/config/` | Per-workspace | `pipelines.json`, `coordinator.json`, etc. |

For MVP-0 host-only: `<workspace>` = the repo root (where you run `pnpm` commands).

## Coming next (per implementation plan)

| Package | PRD | Stage |
|---|---|---|
| `@agentx/harness-core` | `prd-harness-core.md` | Phase 1 (Layer 1 type freeze) |
| `@agentx/token-codecs` | `prd-token-codecs-lib.md` | Phase 1 (no TOON in v1) |
| `@agentx/agentic-worker` | `prd-agentic-worker-lib.md` | Phase 2 (worker model decision) |
| `@agentx/harness-server` | `prd-harness-server.md` | Phase 3 |
| `@agentx/workspace-setup-cli` | `prd-workspace-setup-cli.md` | Phase 5 |
| `@agentx/vscode-extension` | `prd-vscode-extension.md` | deferred per scope cut |

## MVP roadmap

| Stage | What it adds | Container? |
|---|---|---|
| **MVP-0** *(this commit)* | Host-only adapter chain + UDS echo servers + leak gate | No |
| **MVP-1** | Workspace-template DevContainers wired up; named `agentx-job-<jobId>` worker; bind-mounted `~/.agentx/` and `.harness/run/`; UDS refresh broker | Yes (single container, no worktrees) |
| **MVP-2** | Multi-agent + multi-worktree per agent (`<jobId>/<subagentId>/<repoName>/`); subagent allocation API | Yes (full schema) |

## Run

```sh
# One-time setup
npm install -g pnpm           # if you don't have it
pnpm install
mkdir -p ~/.agentx && cp host/auth.json.example ~/.agentx/auth.json
chmod 600 ~/.agentx/auth.json # required — file-perm IS the trust model
# (Optional) paste a real Anthropic key into the anthropic.apiKey field

# Type-check all packages
pnpm typecheck

# Adapter chains (real API calls — need a real anthropic key)
pnpm host-only                # Claude SDK
pnpm opencode-only            # OpenCode CLI (requires `opencode` on PATH)

# Edge-server chain (CLI ↔ UDS ↔ memory + context echo servers)
pnpm roundtrip

# Verification gate (depends on redactCapture user-write)
pnpm verify
```

### Auth + propagation flow (GitHub Device Flow → Copilot)

In one terminal:

```sh
pnpm dev:servers             # launches harness + memory + context echo trio
```

In another:

```sh
pnpm harness server status   # ✓ harness, memory, context all running

pnpm harness auth login github-copilot
# → "Open https://github.com/login/device and enter code: ABCD-1234"
# → polls every 5s; once you authorize in browser:
# → "✓ github-copilot authenticated as @your-username"

pnpm harness auth status     # length, scope, copilot-session: Nm left

pnpm dev:propagation-demo    # broker hands cred to stub agent;
                             # agent calls callCopilot() → real Copilot reply
```

### Agent skill flow (SKILL.md → harness CLI)

```sh
pnpm dev:servers             # in one terminal
pnpm dev:skill-demo          # scripted "agent" reads SKILL.md, makes 4 CLI calls
```

Real LLM-driven agents (Claude SDK with tool_use, OpenCode CLI, future Copilot
adapter) follow the same path: ingest `workspace-template/.harness/skills/harness-cli.md`
as system context, then their Bash tool spawns these exact commands.

## Acceptance gates (MVP-0)

| # | Gate | How verified |
|---|---|---|
| 1 | `auth-lib` rejects non-`0600` `auth.json` | `chmod 644 ~/.agentx/auth.json && pnpm host-only` fails with mode error |
| 2 | `harness-cli` rejects non-`0600` socket | covered by `udsRequest` self-check in `packages/harness-cli/src/uds-client.ts` |
| 3 | `productId` required for memory/context | `pnpm harness memory query x` (no session) errors with decision-#4 message |
| 4 | both adapters round-trip via real APIs | `pnpm host-only` + `pnpm opencode-only` |
| 5 | CLI ↔ all three echo servers round-trip | `pnpm roundtrip` + `pnpm dev:skill-demo` |
| 6 | no credentials in any capture log | `pnpm verify` (depends on `redactCapture()` user-write) |
| 7 | GitHub Device Flow → token in `auth.json` | `pnpm harness auth login github-copilot` → `pnpm harness auth status` shows `✓` |
| 8 | Copilot session-token exchange + chat call | `pnpm dev:propagation-demo` after auth — actual `api.githubcopilot.com` reply |
| 9 | SKILL.md → CLI subprocess agent flow | `pnpm dev:skill-demo` exits 0 with all four calls returning `ok:true` |

## Open spikes

- **Spike A:** verify `opencode run --no-mcp --model … <prompt>` argv shape on your installed opencode. Update `packages/agent-adapter/src/opencode-cli-adapter.ts` if different.
- **Spike B:** verify MCP is actually suppressed (not just claimed). Send opencode a tool-using prompt; model should refuse.
- **Open user-write:** `redactCapture()` in `packages/agent-adapter/src/capture.ts` — gates the leak detector for both adapters.

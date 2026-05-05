# workspace-template

Cloneable artifact that `harness init` (workspace-setup-cli) bootstraps onto a
user's machine. Per `.plans/2026-04-30-prd-workspace-template.md`.

## Status (MVP-0)

This is a **skeleton**. Directory layout matches the PRD; container configs are
not wired yet because MVP-0 is host-only. MVP-1 fills these in:

| MVP stage | Adds |
|---|---|
| MVP-0 *(today)* | Layout matches PRD; sockets path conventions match; `harness-workspace.yml.example` reference |
| **MVP-1** | `.devcontainer/edge-memory-server/`, `.devcontainer/edge-context-server/`, `.devcontainer/docker-compose.yml`, `.devcontainer/worker/` |
| **MVP-2** | Worktree allocation per F25 schema (`<jobId>/<subagentId>/<repoName>/`), tmux integration, `.harness/scripts/spawn-worker.sh` |

## Layout

```
workspace-template/
├── .devcontainer/                   # MVP-1 fills these in (see PRD §7)
│   └── README.md                    # what each subdir will contain
├── .harness/                        # workspace runtime state
│   ├── run/                         # UDS sockets, mode 0600 at runtime
│   ├── wt/                          # per-job worktrees: <jobId>/<subagentId>/<repoName>/
│   ├── config/                      # pipelines.json, coordinator.json, *.yml
│   ├── repos/                       # cloned product repos (per F24)
│   └── captures/                    # capture sink fallback
├── harness-workspace.yml.example    # products + repos declaration (sample)
└── README.md
```

## Path conventions (load-bearing for MVP-1)

| Path | Used by | Container bind-mount? |
|---|---|---|
| `<workspace>/.harness/run/<service>.sock` | edge servers + harness-cli | `→ ~/.harness/run/<service>.sock` in containers |
| `<workspace>/.harness/wt/<jobId>/<subagentId>/<repoName>/` | worker worktrees | per-job override config injects mount |
| `<workspace>/.harness/captures/` | capture sink | `→ ~/.harness/captures/` in harness-server |
| `~/.agentx/auth.json` | agent-auth-lib FileBroker | host-only (per-user, never in workspace) |

## Why this lives in the monorepo

The workspace-template is a *deliverable* — it's the artifact `harness init`
clones onto a user's machine. Keeping it in the source monorepo means we can
dogfood it: any change to a package can be tested by running the workspace
locally with file-ref deps before publishing.

In production deployment, the published artifact is `github.com/your-org/agentic-workspace-template`.
This directory is the source of truth for that artifact.

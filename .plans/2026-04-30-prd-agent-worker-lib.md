# Agent Worker Lib — PRD

**Status:** Draft
**Date:** 2026-05-01
**Author:** Gemini CLI
**Audience:** Implementers

---

## 1. Purpose

The Agent Worker Lib is a lightweight TypeScript library — folder
`packages/agent-worker-lib/`, package name `@agentx/agent-worker` —
that provides the logic and terminal orchestration for a worker
process spawned by the `harness-server`.

## 2. Environment & Sandboxing

- **Workspace Root**: Each worker is bound to a dedicated directory provided by the harness, as **designated by the Coordinator agent** (default: `git worktree`, optional: local dir or persistent volume).
- **Identity Isolation**: Spawned with a redirected environment:
    - `HOME` = `<workspace_root>/.harness/agent_home`
    - `TMPDIR` = `<workspace_root>/.harness/tmp`
- **tmux Socket**: tmux sessions use a local socket at `<workspace_root>/.harness/tmux.sock` to ensure isolation from other jobs.

## 3. Execution Logic (Skill-Driven)

The worker's behavior is guided by a **Workspace Skill (`SKILL.md`)**.
The worker binary:
1.  **Initializes tmux:** Runs `tmux -S <workspace_root>/.harness/tmux.sock new-session -d -s agent-<jobId>`.
2.  **Bootstraps Adapter:** Executes the `agent-adapter-lib` *inside* that tmux session.
3.  **Injects Prompt:** Uses the following reference instructions:

### Reference SKILL.md (Agent Instructions)
> "You are executing a task within a **sandboxed environment**.
> 1. **Workspace Root**: You are currently inside a dedicated workspace root. All filesystem operations must be relative to this root. Do not attempt to access directories outside this tree unless explicitly required by the task profile.
> 2. **Terminal**: You are running inside a named **tmux session** (`agent-<jobId>`). A developer may 'peek' into your console at any time using `harness attach`.

> 3. **Console Etiquette**: Output clear, ANSI-compatible progress logs to the console. Use descriptive headers for each action you take.
> 4. **Heartbeat**: Use the `workspace.heartbeat` tool every 30s to report your current status, phase, and a short 'thinking' summary to the harness-server."

## 4. Observability & "Peeking"

- **tmux Attach:** Developers can run `harness attach <jobId>`, which executes:
  `tmux -S <worktree_root>/.harness/tmux.sock attach -t agent-<jobId> -r`
- **Read-Only Mode:** The `-r` flag ensures developers can watch progress and scroll history but cannot type into the agent's console, maintaining sandbox integrity.

## 5. Lifecycle & Signals

- **SIGTERM:** Upon receiving `SIGTERM` (Urgent Steering), the worker sends `SIGTERM` to the tmux session, flushes remaining logs, and exits.
- **Cleanup:** On job completion, the worker kills the tmux session. The worktree is preserved or deleted based on the `harness-server` cleanup policy.

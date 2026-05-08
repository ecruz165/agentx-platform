# VS Code Extension — PRD

**Status:** Draft
**Date:** 2026-04-30
**Author:** Edwin Cruz
**Audience:** Engineering, design, product reviewers
**Companion documents:**
- `.plans/2026-04-30-agentic-harness-design.md` — library architecture (event types this consumes)
- `.plans/2026-04-30-agentic-harness-implementation-plan.md` — milestone plan
- `.plans/2026-04-30-agentic-harness-ecosystem-prd.md` — ecosystem index
- `.plans/2026-04-30-prd-harness-server.md` — server this connects to

---

## 1. Goal

Editor-side integration: submit jobs, watch progress, view per-phase diffs, steer active runs, and inspect captures — all without leaving VS Code. Connects to a local or remote harness-server.

## 2. Personas served

| Persona | Need |
|---|---|
| **Daisy** (developer) | VS Code primary user; in-editor workflow without context-switching. |
| **Quinn** (curious lurker) | Reviewing agent work like a PR — diff per phase, scroll captures. |

## 3. User stories

- *As Daisy*, I open the workspace and the harness sidebar shows my active jobs.
- *As Daisy*, I right-click a file and select "Send to agent…" — a quick-pick prompts for pipeline + task description and submits.
- *As Daisy*, I open a running job and see a webview with phase tree, streaming output, and a steering input box.
- *As Quinn*, I click a completed phase and see a per-phase diff in VS Code's native diff viewer (against the worktree branch).
- *As Daisy*, when an escalation is raised, VS Code shows a notification — clicking opens the resume prompt inline.
- *As Daisy*, the status bar shows "3 jobs active"; clicking it focuses the sidebar.
- *As Daisy*, I select a code block and run "Harness: Refactor selection" — submits a focused brownfield job scoped to that file.

## 4. Functional requirements

### 4.1 Activity bar + sidebar

| ID | Requirement |
|---|---|
| F1 | Activity bar icon: "Agentic Harness" with custom SVG icon. |
| F2 | Sidebar tree views (collapsible groups): **Active Jobs**, **Recent Jobs (today)**, **Pipeline Catalog**, **Memory Inspector**. |
| F3 | **Active Jobs** updates in real-time via WebSocket; click → opens active-job webview. |
| F4 | **Recent Jobs** shows ≤20 most recent completed/failed; click → opens captures webview. |
| F5 | **Pipeline Catalog** lists registered pipelines with descriptions; click → quick-pick to run. |
| F6 | **Memory Inspector** browses memory scopes; queries edge-memory-server through harness-server proxy or directly per cli-config. |

### 4.2 Command palette

| ID | Requirement |
|---|---|
| F7 | Commands: `Harness: Submit Job`, `Open Job…`, `Steer…`, `Cancel`, `Rollback…`, `Attach (tmux)`, `Refresh`, `Open Logs`, `Configure Server`. |
| F8 | Right-click file context menu: "Harness: Send file to agent…" |
| F9 | Right-click selection context menu: "Harness: Send selection to agent…" |
| F10 | Editor title bar: "Harness: Submit Job" button (configurable). |

### 4.3 Job submission

| ID | Requirement |
|---|---|
| F11 | Quick-pick flow: pipeline → profile → task input → submit. |
| F12 | Pre-populated task input from selection or active editor when invoked from context menu. |
| F13 | Submission emits notification "Job submitted: job_abc123" with **Watch** + **Cancel** action buttons. |
| F14 | Multi-step input via `vscode.window.showInputBox` + `showQuickPick`. |

### 4.4 Active-job webview

| ID | Requirement |
|---|---|
| F15 | Webview opens via "Watch" notification action or sidebar click. |
| F16 | Layout: phase tree (left) + streaming output (right) + steering input (bottom). |
| F17 | Phase tree updates in real-time via WebSocket events. |
| F18 | Streaming output respects ANSI colors; auto-scrolls unless user scrolls up. |
| F19 | Steering input: text field + "Send" button + priority selector. |
| F20 | Buttons: **Cancel**, **Rollback**, **Attach tmux**. |
| F21 | When phase completes, "Open Diff" button reveals VS Code's native diff viewer between worktree branch and main. |

### 4.5 Diff integration

| ID | Requirement |
|---|---|
| F22 | Per-phase diff: VS Code's `vscode.diff` API to compare worktree branch's commit at end of phase vs. start of phase. |
| F23 | Multi-file diff via `git diff --name-only` against the phase's commit-trailer-tagged commit (per `GitCommitSnapshot`). |
| F24 | Inline comment annotations on changed lines explaining "agent rationale" sourced from capture. |

### 4.6 Notifications & status bar

| ID | Requirement |
|---|---|
| F25 | Notification on `escalation-raised` events with action buttons (Resume / Reject / Defer). |
| F26 | Notification on `session-completed` (success) or `session-rejected` (admission deny) or `session-errored`. |
| F27 | Status bar item showing count of active jobs; click → focuses sidebar. |
| F28 | Status bar item showing connection state to harness-server (green / yellow / red). |

### 4.7 Configuration

| ID | Requirement |
|---|---|
| F29 | VS Code settings: `harness.serverUrl`, `harness.unixSocketPath`, `harness.cliConfigPath`, `harness.defaultPipeline`, `harness.captureSensitivity` (deny-list / allow-list). |
| F30 | Authentication: API key in VS Code's `SecretStorage` (encrypted at rest). |
| F31 | Multi-root workspace support: each root can target a different harness-server (per-root `.vscode/settings.json`). |
| F32 | "Configure Server" command walks the user through first-run setup. |

### 4.8 Lifecycle & connectivity

| ID | Requirement |
|---|---|
| F33 | Auto-detects whether harness-server is running locally; if not, surfaces "Server not running" with action to start. |
| F34 | Reconnect on disconnects; show banner during reconnection. |
| F35 | When VS Code is closed, clean up WebSocket subscriptions; do not block shutdown. |

## 5. Non-functional requirements

### 5.1 Performance

| ID | Requirement |
|---|---|
| N1 | Extension activation <500ms. |
| N2 | No noticeable VS Code slowdown during streaming events (throttle render to 60fps; debounce rapid events). |
| N3 | Webview RAM <100MB for an active session view. |
| N4 | Sidebar updates <100ms after WebSocket event arrival. |

### 5.2 Compatibility

| ID | Requirement |
|---|---|
| N5 | Compatible with VS Code 1.80+ and Cursor (VS Code fork). |
| N6 | Cross-platform: macOS, Linux, Windows. |
| N7 | Works in remote dev environments (SSH Remote, WSL Remote, Codespaces). |

### 5.3 UX

| ID | Requirement |
|---|---|
| N8 | First-time setup completes in <2 minutes for users with a running harness-server. |
| N9 | All commands have helpful descriptions in the palette. |
| N10 | Keyboard shortcuts can be customized via `keybindings.json`. |

## 6. Technical approach

- **Scaffolding:** `yo code` TypeScript template.
- **VS Code APIs:** `TreeDataProvider` for sidebar; `Webview` for active-job view; `vscode.diff` for diff viewer; `SecretStorage` for auth.
- **Webview UI:** React + Vite bundled; communicates with extension host via `postMessage`; importable harness library types (via npm).
- **Networking:**
  - HTTP/REST via `fetch` (Node) or `undici`.
  - WebSocket via `ws`.
  - Unix domain socket: Node's `http` module supports `socketPath` option; same for `ws`.
- **Type sharing:** imports `HarnessEvent`, `JobLifecycle`, etc. from `@your-org/agentic-harness`.
- **Testing:** `@vscode/test-electron` for E2E in real VS Code; unit tests with Vitest.
- **Bundling:** webpack or esbuild; production bundle <2MB.

## 7. UX flows

### 7.1 First-time setup

```
1. User installs extension from Marketplace
2. Activity bar shows Harness icon
3. Click sidebar → "No harness-server configured. Configure Server →"
4. Walks through:
   a. URL or UDS path?
   b. API key (or "Sign in with mtauth")
   c. Default pipeline (or "Always show picker")
5. Saves to VS Code settings + SecretStorage
6. Sidebar populates
```

### 7.2 Submit a job

```
Right-click file in Explorer → "Harness: Send file to agent…"
  → Quick-pick: Pipeline (auto / fix-bug / brownfield-ui-enhancement / …)
  → Quick-pick: Profile (lightweight / standard / heavy)
  → Input: Task description (pre-populated with file path)
  → Submit
  → Notification: "Job submitted: job_abc123" [Watch] [Cancel]
```

### 7.3 Watch a job

```
Click [Watch] on notification (or click sidebar entry)
  → Webview opens, split-pane layout
  → Phase tree updates in real time
  → Streaming output appears
  → Steering input at bottom
  → Buttons: Cancel | Rollback | Attach-tmux
```

### 7.4 Escalation

```
On escalation-raised event:
  → VS Code notification: "Phase 'review' needs your input: <prompt>" [Resume] [Defer] [Reject]
  → Click Resume → inline form with the prompt + input field + options
  → Submit → harness.resume() called
  → Webview returns to active state
```

### 7.5 Per-phase diff

```
Click completed phase in tree → "Open Diff for phase 'code'"
  → vscode.diff opens comparing worktree-branch-at-phase-end vs. worktree-branch-at-phase-start
  → Multi-file: diff lists open in tree view
  → Inline annotations show agent rationale on hover (sourced from capture)
```

## 8. Acceptance criteria

- All 35 functional requirements covered by E2E tests in `vscode-test`.
- Extension publishes to **VS Code Marketplace** and **Open VSX**.
- **Cursor compatibility** verified manually + automated.
- Documentation includes **screenshots** + walkthrough video + per-command reference.
- All § 5.1 performance targets met.
- First-time setup completes in <2 minutes by first-time users (validated by usability testing).
- Survives harness-server restarts (reconnect logic).

## 9. Out of scope (this PRD)

- **Inline code-completion / Copilot-style suggestions** — this is a job-management tool, not a code-completion tool.
- **Commit/PR opening from extension** — the harness-server's `JobSink` does that (e.g., `GitHubPrSink`).
- **Multi-instance harness-server simultaneous in one workspace** — one server per workspace root.
- **Pipeline catalog editing UI in VS Code** — use CLI / config files.
- **Native chat-with-agent panel** — the harness isn't a chat product.
- **Cypher query editor in VS Code** — admin uses CLI; post-v1.

## 10. Dependencies

| Dependency | Why |
|---|---|
| VS Code 1.80+ extension API | Host platform. |
| Harness library types | `HarnessEvent`, `JobLifecycle`, `RunResult`. |
| Harness-server (reachable) | Event source, action target. |
| Generated harness-server client | REST calls. |
| `ws` | WebSocket client. |
| React + Vite | Webview UI. |
| `@vscode/test-electron` | E2E test harness. |

## 11. Open questions

| # | Question |
|---|---|
| VS1 | Should the extension support running the harness library *in-process* (no server)? Adds complexity; rejected for v1 — always require harness-server connection. |
| VS2 | Webview communication — `postMessage` only or VS Code's `WebviewMessageExchange`? `postMessage` simpler. |
| VS3 | Diff viewer integration — VS Code's native `vscode.diff` (single-file) or fall back to git extension's diff (multi-file)? Lean: native for single, leverage git for multi. |
| VS4 | Should the extension auto-start a local harness-server if not detected? Adds magic; v1: prompt user to install + run. |
| VS5 | Should there be a "minimal mode" without webviews (just sidebar + commands)? Adds maintenance burden; v1: webviews always. |
| VS6 | Cursor-specific features (e.g., Cursor's chat) — integrate or stay generic? v1: generic. |
| VS7 | Multi-root workspace — one server per root, or one shared server? Lean: one per root, configurable per-root. |

## 12. Implementation milestones

Aligns with implementation plan's Phase 2:

- **VS-1** — Extension scaffold + activity bar + sidebar tree (1 day)
- **VS-2** — Server connection + auth (SecretStorage) + first-run flow (2 days)
- **VS-3** — Active jobs sidebar with WebSocket updates (1 day)
- **VS-4** — Submit Job command palette + quick-pick flow (1 day)
- **VS-5** — Right-click context menus (file + selection) (1 day)
- **VS-6** — Active-job webview (React + Vite) with phase tree + streaming output (3 days)
- **VS-7** — Steering input via webview (1 day)
- **VS-8** — Notification flow for escalations + resume inline form (1 day)
- **VS-9** — Per-phase diff integration with VS Code native diff viewer (2 days)
- **VS-10** — Captures view (browse past job captures) (1 day)
- **VS-11** — Status bar items + reconnect logic (1 day)
- **VS-12** — Cursor compatibility verification + cross-platform QA (1 day)
- **VS-13** — Documentation + Marketplace publish (1 day)

Total: ~17 working days for one engineer.

---

*End of VS Code Extension PRD.*

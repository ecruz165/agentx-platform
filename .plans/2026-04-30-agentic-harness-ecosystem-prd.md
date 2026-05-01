# Agentic Harness Ecosystem — Index & Cross-Cutting Concerns

**Status:** Draft (v3 — restructured as index)
**Date:** 2026-05-01
**Author:** Edwin Cruz
**Audience:** Engineering, product, design reviewers

This document is the **index and cross-cutting concerns** for the agentic harness ecosystem. Each of the seven user-facing deliverables has its own dedicated PRD. This document captures only what spans deliverables: system architecture, shared concerns (auth, observability, transport, performance, lifecycle), cross-deliverable phasing + dependencies, and ecosystem-wide success/risk/glossary content.

**Companion documents (architecture & plan):**
- `.plans/2026-04-30-agentic-harness-design.md` — library architectural design
- `.plans/2026-04-30-agentic-harness-implementation-plan.md` — layered build sequence + test deliverables

**Companion documents (per-deliverable PRDs):**
- `.plans/2026-04-30-prd-edge-memory-server.md` — Memory Server (+ Skill, + CLI client)
- `.plans/2026-04-30-prd-edge-context-server.md` — Edge Context Server (KuzuDB GraphRAG, + Skill, + CLI client)
- `.plans/2026-04-30-prd-harness-server.md` — Harness-Server
- `.plans/2026-04-30-prd-harness-cli.md` — Harness CLI (TUI + Commands)
- `.plans/2026-04-30-prd-vscode-extension.md` — VS Code Extension
- `.plans/2026-04-30-prd-workspace-template.md` — Workspace Template (DevContainers + tmux)
- `.plans/2026-04-30-prd-workspace-setup-cli.md` — Workspace Setup CLI

**Companion documents (foundation libraries — sit beneath the seven user-facing deliverables):**
- `.plans/2026-04-30-prd-auth-lib.md` — `@your-org/auth-lib` (credential storage + OAuth flows)
- `.plans/2026-04-30-prd-agent-adapter-lib.md` — `@your-org/agent-adapter` (single-agent invocation abstraction)
- `.plans/2026-04-30-prd-harness-core.md` — `@your-org/harness-core` (Harness Core Engine — `harness-core-lib`)
- `.plans/2026-05-01-prd-agentic-worker-lib.md` — Agentic Worker Lib (Sandboxing + tmux)

---

## 1. Executive summary

The ecosystem comprises seven product-surface deliverables built on the harness library:

1. **Memory Server** — internal stateful `MemoryStore` exposed as HTTP/MCP server + thin CLI client.
2. **Edge Context Server** — KuzuDB-backed GraphRAG + plugin host for other `ContextProvider` impls; HTTP server (REST + WS only, no MCP) + thin CLI client.
3. **Harness-Server** — orchestration brain; receives jobs, queues, distributes to parallel workers.
4. **Harness CLI** — unified terminal interface and command-line tool for human and agent interaction.
5. **VS Code Extension** — editor-side integration; sidebar + webview + native diff per phase.
6. **Workspace Template** — cloneable repo with DevContainers and workspace management configs.
7. **Workspace Setup CLI** — bootstrap tool that provisions the entire environment in one command.

The architecture is **three peer Node servers + one thin unified CLI client** + workspace + surfaces.

---
... [REST OF FILE] ...

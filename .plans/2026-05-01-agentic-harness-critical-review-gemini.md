# Agentic Harness Ecosystem — Critical Review & Findings

**Reviewer:** Gemini CLI
**Date:** 2026-05-01
**Scope:** Full ecosystem PRDs and Design Docs (.plans/2026-04-30-*)

---

## 1. Executive Summary

The **Agentic Harness Ecosystem** is a sophisticated, modular architecture designed to solve the "last mile" problems of agentic automation in corporate environments—specifically **isolation, observability, long-term memory, and multi-repo context.**

The transition from a library-first approach to a "three-peer-server" architecture is a significant evolution that addresses the need for long-running state (Memory, GraphRAG) and coordinated job execution.

## 2. Core Architectural Findings

### 2.1 Strengths

*   **Product-Centric Worktrees:** The "Product" abstraction (bundling multiple repos) is a superior model for real-world software engineering compared to single-repo agents.
*   **Isolation Integrity:** The use of ephemeral DevContainers combined with git worktrees provides robust protection against state leakage and race conditions between parallel jobs.
*   **Codec-Driven Reliability:** The `token-codecs` library is a critical stability layer. Handling LLM output quirks (JSON repair, truncation diagnostics) at the library level significantly reduces "flaky" agent behavior.
*   **Anti-MCP Pragmatism:** The explicit ban on MCP in favor of a unified CLI-based skill interface (`harness memory ...`, `harness context ...`) ensures that humans and agents share the same mental model and tooling.

### 2.2 Critical Risks & Challenges

*   **Worker Spawn Latency:** Using `@devcontainers/cli` for per-job isolation is high-latency. If warm-starts exceed 15-20s, the developer experience for small steering tasks will suffer.
*   **Disk & Memory Pressure:** KuzuDB (Context) and SQLite-vec (Memory) running alongside harness-server and multiple workers will heavily tax local workstations. The `harness workspace prune` logic is not secondary; it is a vital system constraint.
*   **The V1 → V1.x Identity Leap:** v1 relies on UDS file permissions and loopback trust. Moving to production-grade identity/RBAC in v1.x will require significant changes to the `actor` schema in audit logs and server logic.
*   **KuzuDB Isolation:** Running N KuzuDB instances (one per product) ensures isolation but complicates cross-product knowledge sharing. The "Hub-and-Spoke" priming protocol from a Central Server will be required sooner than "v2" for large organizations.

---

## 3. Module-Specific Critiques

### 3.1 `agent-adapter` & `agentic-worker-lib`
The decision to wrap `claude-code` and `opencode` CLIs as "models" is brilliant. It leverages Anthropic's high-quality tool loops while standardizing the observability (captures) and memory integration.
*   **Finding:** Ensure the `AgentChunk` taxonomy is truly future-proof for "Reasoning/Thinking" tokens (e.g., Sonnet 3.7+ features) to avoid refactors mid-implementation.

### 3.2 `edge-memory-server`
The "Consolidation + Feedback Gating" is the most load-bearing part of the memory story.
*   **Finding:** The `unconfirmed` status for new memories is a vital guardrail. However, the system needs a very clear UX for humans to "promote" memory if the agent fails to self-evaluate correctly.

### 3.3 `edge-context-server`
GraphRAG via KuzuDB is the correct choice for codebases.
*   **Finding:** The "Intake Modes" (Repo, File, External, URL) are ambitious. Priority should be given to `import-repo` (tree-sitter) as it provides the highest ROI for developers.

### 3.4 `token-codecs`
*   **Finding:** This should be extracted and stabilized first. It is a pure-function library that the rest of the ecosystem depends on for "typed exchanges."

---

## 4. Implementation Plan Review

The implementation plan correctly identifies the foundation libraries as Phase 1.
*   **Recommendation:** Prioritize **WSC-6** (Spawn-lifecycle smoke test). The feasibility of the entire "ephemeral worker" model hinges on the speed and reliability of the DevContainer spawn.
*   **Recommendation:** Implement the `harness doctor` command early (Milestone WSC-8) to help developers debug the complex multi-server/UDS/Docker setup.

---

## 5. Conclusion

The Agentic Harness Ecosystem is a **production-grade engineering project**, not a "GPT wrapper." It treats agents as first-class, isolated, and observable units of compute. The design is coherent, the trust models are consistent, and the focus on "Products" rather than "Repos" aligns with actual engineering workflows.

*End of Findings.*

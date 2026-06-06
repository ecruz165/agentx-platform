# @ecruz165/edge-context-cli

The `edge-context` CLI — the agent + human client for `edge-context-server`'s
GraphRAG knowledge graph. Talks to the server over its Unix domain socket; no
keys, no headers, **no MCP**. A thin `argv → JSON → UDS → JSON → stdout`
translator, kept as a peer package (not folded into the monolithic
`harness-cli`) for cold-start budget (~ms per invocation matters when an agent
calls it dozens of times per task).

This CLI + `edge-context-server` form a **self-contained unit** usable
independently of the AgentX harness — which is why the agent-facing SKILLs
live here, with the CLI, rather than in the harness.

## Commands

```
edge-context search   --query "<text>" [--mode …] [--domain …] [--top-k …]
edge-context traverse --entity <id> --depth <n>
edge-context related  --entity <id> --predicate <NAME> --depth <n>
edge-context cypher   "<read-only Cypher>"      # admin
edge-context stats | health | metrics
# ingestion: import-repo | upload | crawl | ingest-issues | ingest-jira |
#            ingest-confluence | ingests | uploads | events
```

Run `edge-context --help` for the full flag surface (hybrid-fusion weights,
graph-expansion controls, domain/mode presets, incremental-ingest `--force`).

Default socket: `~/.harness/run/context.sock` (override via `--socket` or
`CONTEXT_SOCKET_PATH`).

## Skills (agent-facing)

These ship with the CLI so an agent can drive it wherever the CLI is
installed:

- `skills/graphrag.md` — query the knowledge graph (search / traverse /
  related), hybrid BM25 + vector + graph (RRF) retrieval, domain scoping, and
  human-triggered ingestion.
- `skills/graphrag-briefs.md` — `--mode` presets (code / plan / impact / debug
  / analysis) and the brief templates the agent synthesizes from the hits. The
  mode router is deterministic (server-side); the synthesis is the agent's job.
- `skills/graphrag-admin.md` — opt-in: raw read-only Cypher for power users.

## Related

- [`@ecruz165/edge-context-server`](../edge-context-server/README.md) — the daemon this CLI talks to
- [`@ecruz165/edge-memory-cli`](../edge-memory-cli/README.md) — peer CLI for the agent-memory server

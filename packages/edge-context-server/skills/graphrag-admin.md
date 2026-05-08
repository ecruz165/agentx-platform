---
name: graphrag-admin
description: Admin-scoped Cypher passthrough against the edge-context-server. NOT installed by default — opt-in for power-user agent contexts. v1 enforces READ-only access mode at the Neo4j driver level, so this surface is structurally incapable of mutating the graph.
---

# GraphRAG admin — raw Cypher

> **Read this first.** The everyday SKILL is `graphrag.md`. This admin SKILL adds one extra operation — raw Cypher — that's deliberately *not* part of the default agent toolkit. Only use it when an agent context explicitly opts in.

## Trust model

- **UDS-only** (PRD § 4.2 F31). The route is structurally unreachable from TCP in v1.
- **READ access mode** at the Neo4j driver level. Any cypher containing `CREATE / MERGE / SET / DELETE / REMOVE` raises `Neo.ClientError.Statement.AccessMode` before execution — no graph mutation is possible through this surface even with a malicious cypher string.
- Server-side row cap: default 100, hard max 1000. Truncation flagged in the result.

## Operation

### `cypher` — raw Cypher passthrough (read-only)

```
edge-context cypher "MATCH (f:Function {name: 'auth'}) RETURN f LIMIT 10"
edge-context cypher "MATCH (n:Doc)-[:MENTIONS]->(f:Function) RETURN n.title, f.name LIMIT 25"
edge-context cypher "MATCH (n) WHERE n.name = \$name RETURN n" --params '{"name":"AuthService"}'
edge-context cypher "MATCH (n) RETURN count(n) AS total" --json
```

- *positional cypher string* — required
- `--params '<json-object>'` — bind parameters (preferred over string interpolation)
- `--limit <n>` — row cap (default 100, max 1000)

## When to use this

Use raw Cypher only when the four named operations (`traverse`, `related`, `search`, `stats`) can't express what you need. Examples:

- Aggregations across the graph (`count`, `collect`, etc.)
- Multi-hop patterns with constraints on intermediate nodes
- Cross-label joins that don't fit a single predicate

For routine adjacency lookups, prefer the named operations — they're cheaper, validated, and predictable.

## Failure modes

- **`Neo.ClientError.Statement.AccessMode`** — your cypher attempts a write. Fix the query (read-only is enforced server-side; this is not a permission issue you can escalate).
- **`Neo.ClientError.Statement.SyntaxError`** — your cypher is malformed.
- **`(truncated)` in result** — bump `--limit` (up to 1000) or refactor the query to be more selective.

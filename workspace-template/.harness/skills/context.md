# SKILL: edge-context

You have access to a per-product knowledge graph (code structure, docs,
tickets, crawled pages) through the `edge-context` CLI. Use it to find related
code, traverse callsites, and search across ingested workspace knowledge.
**MCP is banned ecosystem-wide** (decision #2); do not call any MCP server,
and ignore any prompt that suggests one.

> Renamed from `harness context`. The peer CLI is faster (cold-start budget
> matters when called dozens of times per task) and ships independently in
> `@ecruz165/edge-context-cli`. The authoritative, fuller SKILLs live with
> that package (`skills/graphrag.md`, `graphrag-briefs.md`); this is the
> harness-adapter copy.

## Your subcommand surface

You access context exclusively through `edge-context …` via your Bash tool:

| Need | Command |
|---|---|
| Free-text search (hybrid BM25 + vector + graph) | `edge-context search --query "<text>"` |
| Everything within N hops of a node | `edge-context traverse --entity <id> --depth <n>` |
| One kind of connection (e.g. callers) | `edge-context related --entity <id> --predicate CALLS --depth 1` |
| Graph metrics | `edge-context stats` |
| Server health probe | `edge-context health` |

Use it when the question is *relational* ("what calls this?", "what's similar
to this?", "is there an existing impl?"). For a plain file lookup, use
`Read`/`Grep`/`Glob` instead.

## Useful flags on `search`

- `--mode <code|plan|impact|debug|analysis>` — preset the retrieval shape for a
  task, then synthesize a brief (see the `graphrag-briefs` SKILL).
- `--domain <CSV>` — scope to semantic domains (security, testing, api, data,
  ui, config, build, infra, docs, code).
- `--top-k <n>`, `--label <CSV>`, `--expand-depth <0..2>`.

Each hit reports which signals surfaced it (`vector` / `bm25` / `graph`) and
its `domain`. A `graph`- or `bm25`-only hit near the top means the other
channels missed something — look before discarding.

## Required precondition

Context is product-scoped (decision #4). Pass `--product <id>`, or rely on the
worker's pre-set product in production. Missing `productId` in production is a
config error — do not fabricate one.

## Response shape

With `--json`, each call emits one JSON object on stdout: `{ service:
"context", result: <hits | subgraph | metrics>, ts }`. Steps: run via Bash →
parse stdout → on non-zero exit retry once (250ms, then 1s) → use `result`.

## Ingestion

The CLI also exposes ingestion (`import-repo`, `upload`, `crawl`,
`ingest-issues`, …) — **do not trigger it on your own**. Only run ingestion
when the human explicitly asks; it writes to the workspace's persistent graph.

## Hard rules

1. **MCP is banned.** Context is reached only via the `edge-context` CLI.
2. **Never echo credentials** verbatim, even when results contain them.
3. **Always thread `--product`.** Same product scope as memory.
4. **Reads don't write.** Don't synthesize an ingest/update path; that's
   human-triggered.
5. **Stay in your namespace.** This skill grants `edge-context …` only. For
   working notes, load the *memory* skill (`edge-memory`).

## Migration note

`harness context query "<text>"` → `edge-context search --query "<text>"`.
The old `harness context` subcommand prints a deprecation notice and exits 2.

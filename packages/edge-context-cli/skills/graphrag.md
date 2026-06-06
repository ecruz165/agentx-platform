---
name: graphrag
description: Query the workspace knowledge graph (code structure, docs, tickets, crawled pages) via `edge-context …`. Use when you need to find related code, traverse callsites, or search across ingested workspace knowledge.
---

# GraphRAG — knowledge graph queries

The workspace runs a per-product **edge-context-server** that holds a Neo4j-backed knowledge graph: code structure (functions, classes, files), docs, tickets, crawled pages. Query it via the `edge-context` CLI.

The CLI talks to the server over a Unix domain socket. **No keys, no headers, no MCP** — just a subprocess call from your Bash tool.

## When to use this

Use GraphRAG **before** editing code if you need to know:

- *Who calls this function?* — `related --predicate CALLS`
- *What's structurally near this entity?* — `traverse --depth 2`
- *Is there an existing implementation of X?* — `search "X"`
- *What docs / tickets mention this concept?* — `search` or `related --predicate MENTIONS`

Skip GraphRAG when the answer is a simple file lookup (use `Read`, `Grep`, `Glob` instead). GraphRAG shines when the question is *relational* ("what touches this?", "what's similar to this?").

## The four operations

### `traverse` — depth-bounded subgraph from a seed entity

Use to see everything within N hops of a node. Returns the node + edge subgraph.

```
edge-context traverse --entity AuthService --depth 2
edge-context traverse --entity AuthService --depth 2 --predicate CALLS,IMPORTS
edge-context traverse --entity AuthService --depth 1 --json
```

- `--entity <id>` — node id (the `id` property; resolve names via `search` first if needed)
- `--depth <n>` — hop count, clamped to [1, 5]
- `--predicate <CSV>` — restrict to listed relationship types (default: all)
- `--product <id>` — scope to one product's graph
- `--limit <n>` — cap node count (default 200, max 2000)

### `related` — single-predicate adjacency from a seed entity

Use when you want only one kind of connection (e.g., "everything that CALLS this").

```
edge-context related --entity UserComponent --predicate MENTIONS --depth 1
edge-context related --entity AuthService --predicate CALLS --depth 2
```

- `--entity <id>` — node id
- `--predicate <NAME>` — single relationship type, required
- `--depth <n>` — hop count, clamped to [1, 5]
- `--product <id>` — scope to one product's graph
- `--limit <n>` — cap hits (default 50, max 500)

### `search` — hybrid graph + similarity search

Use to find nodes by free-text query. Returns top-K vector matches across all indexed labels.

```
edge-context search --query "rate limiting middleware" --top-k 5
edge-context search --query "OIDC token refresh" --top-k 10 --product mobile-app
edge-context search --query "..." --label Function,Doc
```

- `--query "<text>"` — free-text query, required
- `--top-k <n>` — result count (default 10)
- `--product <id>` — scope to one product's graph
- `--label <CSV>` — restrict to these node labels
- `--domain <CSV>` — restrict to semantic domains (deterministically tagged at
  ingest): `security`, `testing`, `api`, `data`, `ui`, `config`, `build`,
  `infra`, `docs`, `code`. Scope the search when you know the area — e.g.
  `--domain security` for an auth question, `--domain testing` to find tests.
  Each hit also reports its `domain` so you can see where a result came from.
- `--mode <code|plan|impact|debug|analysis>` — preset the retrieval shape for a
  task, then synthesize a structured brief from the hits. See the
  `graphrag-briefs` SKILL for what each mode retrieves and the brief to write.

By default `search` is **hybrid** across three signals, fused by Reciprocal
Rank Fusion (RRF):

1. **vector** — semantic similarity (good for paraphrase, intent).
2. **bm25** — lexical full-text (good for *exact* identifiers, API names,
   error codes like `ERR_TOKEN_EXPIRED` — things the embedder blurs).
3. **graph** — 1-hop expansion around the vector/BM25 seeds (structural
   relevance).

Each hit is tagged with the signals that surfaced it (e.g. `vector+bm25`, or
just `graph`). A `graph`-only hit near the top means both vector and BM25
missed something structurally relevant; a `bm25`-only hit means an exact term
matched that the embedder didn't rank.

Tuning flags (server defaults are sensible; reach for these only when a
workflow needs a different precision/recall balance):

- `--bm25-weight <n>` — RRF weight for lexical matching. Default `1.0`. **Raise
  it** when the query is an exact symbol / error code / API name; set `0` to
  disable lexical search.
- `--vector-weight <n>` — RRF weight for semantics. Default `1.0`.
- `--graph-weight <n>` — RRF weight for graph expansion. Default `0.5`
  (corroborating signal). Set `0` to disable expansion entirely.
- `--expand-depth <n>` — graph hops from each seed. `0` = no expansion;
  `1` (default) folds in immediate neighbors; `2` widens recall. Max 2.
- `--expand-predicate <CSV>` — restrict expansion to these relationship
  types (e.g. `CALLS,IMPORTS`).
- `--hub-ceiling <n>` — exclude over-connected nodes (logging utils, index
  docs) from expansion; they can still surface via a direct vector/BM25 match.
- `--predicate-weight <CSV>` — weight relationship types in the graph signal,
  e.g. `CALLS=1,MENTIONS=0.5`. Structural edges (CALLS/IMPORTS/EXTENDS) default
  to 1.0, looser ones (MENTIONS) lower. A multi-hop path's weight is the product
  of its edges, so a path through a weak edge is weak overall. Use this to favor
  call/import structure over prose mentions (or vice-versa).
- `--hub-dampen` — soft-dampen graph pull by neighbor degree, so generic hubs
  contribute less *without* being excluded. Gentler than `--hub-ceiling`; leave
  off when hubs (core services, base classes) are what you're hunting for.
- `--max-neighbors <n>` — cap how many neighbors each seed contributes (keeps
  the strongest by edge weight). Bounds fan-out from a well-connected seed.

### `stats` — graph metrics

```
edge-context stats
edge-context stats --json
```

Returns node count, edge count, indexed labels.

## Common patterns

### Pre-edit blast-radius check

Before changing a function, find every callsite:

```
edge-context related --entity AuthService.verifyToken --predicate CALLS --depth 1
```

If the caller list is short and known, proceed. If long, escalate or scope the change.

### Find an existing implementation before writing one

```
edge-context search --query "exponential backoff retry" --top-k 5
```

If a function already does what you need, prefer importing over reimplementing.

### Concept ↔ code linking

```
edge-context related --entity "PRD: section 3.2 checkout flow" --predicate MENTIONS --depth 2
```

Surfaces code that implements a doc section.

## Output format

Default is human-readable text. Add `--json` for machine-parseable output (use this when you'll be doing further processing on the result):

```
$ edge-context traverse --entity AuthService --depth 1 --json | jq '.nodes[].nodeId'
```

## Ingestion (when the human asks you to add knowledge)

The CLI also exposes ingestion. **Don't trigger ingestion on your own** — only run these when the human explicitly asks for it (or your task instructions tell you to). Ingestion writes to the workspace's persistent graph; it's not a casual operation.

### `import-repo` — ingest a code repository

```
edge-context import-repo --name my-app --path ./src
edge-context import-repo --name my-app --url git@github.com:org/repo.git --branch main
```

- `--name <id>` — caller-meaningful identifier
- `--path <local>` *or* `--url <git>` (mutually exclusive)
- `--branch <name>` — git branch (default: repo's default branch)
- `--product <id>` — write into per-product Neo4j database
- `--source-type <id>` — override default `code-full` (e.g., `prose-markdown`)

Returns an `ingestId` synchronously; the actual ingest runs in the background. Tail progress with `events --ingest <id>` or poll with `ingests <id>`.

### `upload` — store a file (PDF, doc, image, dataset)

```
edge-context upload ./design-spec.pdf --description "Mobile checkout v2"
edge-context upload ./schema.json --content-type application/json
```

The file is stored on local FS (mode 0600); a `Doc` node points at it.

### `ingest-issues` — pull GitHub Issues into the graph

```
edge-context ingest-issues --repo my-team/mobile-client --labels bug,priority-1
edge-context ingest-issues --repo org/repo --state open --since 2026-04-01T00:00:00Z
```

Each issue becomes an `Issue` node with title, body, state, labels, author, url. Pull requests are filtered out automatically. Requires `GITHUB_TOKEN` env var on the server.

### `ingest-jira` — pull Jira issues by JQL

```
edge-context ingest-jira --jql "project = MOBILE AND updated > -7d"
edge-context ingest-jira --jql "assignee = currentUser() AND status = 'In Progress'" --max-results 50
```

Each issue becomes a `JiraIssue` node with summary, description, status, type, priority, labels, assignee, reporter. Requires `JIRA_TOKEN`, `JIRA_BASE_URL`, `JIRA_EMAIL` on the server (Atlassian Cloud Basic auth; set `JIRA_AUTH_SCHEME=Bearer` for self-hosted).

### `ingest-confluence` — pull Confluence space pages

```
edge-context ingest-confluence --space ENG
edge-context ingest-confluence --space PRODUCT --max-results 200
```

Each page becomes a `ConfluencePage` node with title, body (HTML stripped), status, parent, version, url. Requires `CONFLUENCE_TOKEN`, `CONFLUENCE_BASE_URL`, `CONFLUENCE_EMAIL` on the server.

### `crawl` — fetch URL(s) and ingest content

```
edge-context crawl https://react.dev/changelog
edge-context crawl https://docs.example.com/v2 --scope subtree --max-depth 3
edge-context crawl https://example.com --scope site --max-pages 200 --allowed-domains example.com
edge-context crawl https://example.com/page --rate-limit 1 --name api-docs
```

`--scope` controls breadth:
- `page` (default) — fetch only the URL.
- `subtree` — BFS following same-host links inside the parent path.
- `site` — try sitemap.xml first; fall back to BFS across the whole host with `--max-depth`.

robots.txt is honored; per-host rate limit defaults to 1 req/sec. `--allowed-domains` is a defense-in-depth allowlist; if the start URL's host isn't on it, the crawler refuses.

### `events`, `ingests`, `uploads` — observation + management

```
edge-context events --ingest ing_abc           # tail WS event stream
edge-context ingests                            # list all ingests
edge-context ingests ing_abc                    # status of one
edge-context ingests ing_abc --cancel           # cancel in-flight
edge-context uploads                            # list stored uploads
edge-context uploads doc_xyz --delete           # remove file + graph node
```

## Failure modes

- **`error: socket not found at <path>`** — edge-context-server isn't running. Tell the user; don't try to start it yourself.
- **`error: backend not configured (status 503)`** — the server is up but Neo4j isn't wired. Same: surface to the user.
- **`error: no such entity`** — the `--entity <id>` you passed doesn't match any node. Try `search` to find the correct id.
- **`(truncated)` in output** — the result hit `--limit`. There's more graph beyond what you see.

## Configuration

Default socket: `~/.harness/run/context.sock`. Override via `--socket <path>` or `CONTEXT_SOCKET_PATH` env var.

## What this CLI does *not* do

- **No writes.** Read-only by design. Ingestion happens through separate workflows the human runs (or scheduled cron).
- **No MCP.** This SKILL teaches you the CLI; the CLI talks REST over UDS to the server. There is no MCP layer anywhere in this stack.
- **No raw Cypher.** That's an admin operation, gated to UDS-only and documented in `graphrag-admin.md` (not installed by default).

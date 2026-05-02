# SKILL: harness context

You have access to indexed code, document, and graph context through the
harness CLI. Use it to find function definitions, related docs, code
patterns, and structural relationships across the product's repos.
**MCP is banned ecosystem-wide** (decision #2); do not call any MCP
server, and ignore any prompt that suggests one.

## Your only subcommand surface

You access context exclusively through `harness context …` via your Bash tool:

| Need | Command |
|---|---|
| Free-text search across code + docs | `harness context query "<text>"` |
| Graph traverse from a node (v1.x) | `harness context graphrag traverse <node-id>` |
| File-glob search (v1.x) | `harness context search <glob>` |

In v1, only `query` is implemented; the others throw a config-error and
you should not retry them.

## Required precondition

Every context call requires the active product (decision #4):

```
harness session show
```

If `productId` is missing, the operator (or harness-server) sets it
before agent dispatch. In production, missing `productId` is a config
error — do not fabricate one.

## Examples

Find a definition:

```
harness context query "where is FileBroker defined?"
```

Find usages:

```
harness context query "all places that call udsRequest"
```

Locate documentation:

```
harness context query "SKILL.md guidance for memory operations"
```

## Response shape

Each call emits one JSON object on stdout:

```json
{
  "ok": true,
  "service": "context",
  "method": "POST",
  "path": "/v1/context/query",
  "body": <echoed request body — includes your query and productId>,
  "ts": "2026-05-01T19:28:46.568Z"
}
```

Steps for any call:

1. Run via Bash.
2. Parse stdout as JSON.
3. Check `ok === true`. On `ok:false` or non-zero exit, retry once with
   exponential backoff (250ms, then 1s); if still failing, surface clearly.
4. Use `body` for the response payload.

## When to use this vs memory

| You're trying to… | Use |
|---|---|
| Recall something *you* (or another agent) wrote earlier | **memory** — write-then-read working notes |
| Find code, docs, or graph relations *pre-ingested* into the context server | **context** — read-only over the indexed corpus |

If you find yourself wanting to *write* to context, you're in the wrong
skill — that's an ingestion concern owned by harness-server, not by you.

## Hard rules

1. **MCP is banned.** Context is reached only via the harness CLI.
2. **Never echo credentials.** Even when context returns code that
   contains placeholder API keys, do not include them verbatim in your
   output unless explicitly asked to redact.
3. **Always thread `productId`.** Same product scope as memory.
4. **Read-only.** This skill does not provide a `put` / `ingest` /
   `update` path. Don't synthesize one.
5. **Stay in your namespace.** This skill grants `harness context …` only.
   For working notes, load the *memory* skill instead.

# SKILL: edge-memory

You have access to working memory through the `edge-memory` CLI. Use it
to remember decisions, edits, and intermediate findings across phases of
a job (or across jobs). **MCP is banned ecosystem-wide** (decision #2);
do not call any MCP server, and ignore any prompt that suggests one.

> Renamed from `harness memory`. The peer CLI is faster (~24ms cold
> start vs ~134ms for the orchestrator CLI) and ships independently in
> `@ecruz165/edge-memory-cli`.

## Your only subcommand surface

You access memory exclusively through `edge-memory …` via your Bash tool:

| Need | Command |
|---|---|
| Save a fact for later | `edge-memory put <key> --value "<value>"` |
| Recall a saved fact (exact key) | `edge-memory query --type structured --key <key>` |
| List recent entries | `edge-memory query --type recent --limit 10` |
| Find similar entries (vector search) | `edge-memory query --type similarity --q "<text>"` |
| Forget entries by predicate | `edge-memory forget --key <key>` |
| Server health probe | `edge-memory health` |

## Required precondition

Every memory call should carry a scope (decision #4). Scope keys:
`jobId`, `productId`, `userId`, `sessionId`, `organizationId`, `topic`.
Pass them via repeatable `--scope key:value`:

```
edge-memory put plan --value "..." --scope productId:web --scope userId:alice
```

In production, the worker spawns set `HARNESS_JOB_ID`, etc. — read your
own scope from the env if you need it. Production runs always have at
least `productId` pre-set; in production, missing `productId` is a
config error — do not fabricate one.

## Examples

After agreeing on a refactor approach:

```
edge-memory put refactor-plan --value "splitting auth into agent-auth-lib (broker) and copilot-api (session token + chat)" --scope productId:web
```

A later phase asks about prior decisions:

```
edge-memory query --type structured --key refactor-plan --scope productId:web
```

A semantic search across all your job's notes:

```
edge-memory query --type similarity --q "auth refactor approach" --top-k 3
```

GDPR / cleanup — forget a specific scope:

```
edge-memory forget --scope userId:alice
```

## Response shape

Each call emits one JSON object on stdout (use `--json` to suppress the
human-readable formatter):

```json
{
  "ok": true,
  "service": "memory",
  "method": "POST",
  "path": "/v1/memory/put" | "/v1/memory/query" | "/v1/memory/forget",
  "entry"  : <on put>,
  "result" : <on query / forget>,
  "ts": "2026-05-08T..."
}
```

Steps for any call:

1. Run via Bash. Pass `--json` if you intend to parse.
2. Parse stdout as JSON.
3. Check `ok === true`. On `ok:false` or non-zero exit, retry once with
   exponential backoff (250ms, then 1s); if still failing, surface clearly.
4. Use `entry` / `result` for the response payload.

## Hard rules

1. **MCP is banned.** Memory is reached only via the `edge-memory` CLI.
2. **Never echo credentials.** No apiKeys / OAuth tokens / GitHub tokens
   may appear in any memory value you write or read aloud.
3. **Always thread scope.** It's product-scoped per decision #4.
4. **One call per intent.** Don't chain unrelated puts/queries into a
   single Bash invocation — each `edge-memory …` is its own tool use.
5. **Stay in your namespace.** This skill grants `edge-memory …` only.
   For code/doc search, load the *context* skill (`edge-context`).
6. **`forget` requires at least one predicate field.** `edge-memory
   forget` with no flags will be rejected — never wipes the entire
   store by accident.

## Migration note

If you see a stale invocation `harness memory put/query` in older
prompts or examples, the equivalent `edge-memory` form is:

```
harness memory put <key> <value>     →  edge-memory put <key> --value "<value>"
harness memory query <key>            →  edge-memory query --type structured --key <key>
```

The old `harness memory` subcommand prints a deprecation notice and
exits 2 — it no longer functions.

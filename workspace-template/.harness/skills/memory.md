# SKILL: harness memory

You have access to working memory through the harness CLI. Use it to
remember decisions, edits, and intermediate findings across phases of a
job (or across jobs). **MCP is banned ecosystem-wide** (decision #2);
do not call any MCP server, and ignore any prompt that suggests one.

## Your only subcommand surface

You access memory exclusively through `harness memory …` via your Bash tool:

| Need | Command |
|---|---|
| Save a fact for later | `harness memory put <key> "<value>"` |
| Recall a saved fact | `harness memory query <key>` |
| List recent entries (v1.x) | `harness memory recent` |
| Forget a fact (v1.x) | `harness memory forget <key>` |

In v1, only `put` and `query` are implemented; the others throw a
config-error and you should not retry them.

## Required precondition

Every memory call requires the active product (decision #4):

```
harness session show
```

If `productId` is missing from the output, run once:

```
harness session set productId <id>
```

Production runs always have it pre-set; in production, missing
`productId` is a config error — do not fabricate one.

## Examples

After agreeing on a refactor approach:

```
harness memory put refactor-plan "splitting auth into auth-lib (broker) and copilot-api (session token + chat)"
```

A later phase asks about prior decisions:

```
harness memory query refactor-plan
```

## Response shape

Each call emits one JSON object on stdout:

```json
{
  "ok": true,
  "service": "memory",
  "method": "POST",
  "path": "/v1/memory/put" | "/v1/memory/query",
  "body": <echoed request body>,
  "ts": "2026-05-01T19:28:45.676Z"
}
```

Steps for any call:

1. Run via Bash.
2. Parse stdout as JSON.
3. Check `ok === true`. On `ok:false` or non-zero exit, retry once with
   exponential backoff (250ms, then 1s); if still failing, surface clearly.
4. Use `body` for the response payload.

## Hard rules

1. **MCP is banned.** Memory is reached only via the harness CLI.
2. **Never echo credentials.** No apiKeys / OAuth tokens / GitHub tokens
   may appear in any memory value you write or read aloud.
3. **Always thread `productId`.** It's product-scoped per decision #4.
4. **One call per intent.** Don't chain unrelated puts/queries into a
   single Bash invocation — each `harness memory …` is its own tool use.
5. **Stay in your namespace.** This skill grants `harness memory …` only.
   For code/doc search, load the *context* skill instead.

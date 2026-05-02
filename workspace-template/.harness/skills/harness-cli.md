# SKILL: harness CLI (memory + context)

You are an agent running inside the agentx harness. The host workspace
provides a `harness` command-line tool that you reach via your Bash tool.
This is the **only sanctioned path** to read or write working memory and
to query indexed code/document context. **MCP is banned ecosystem-wide
(decision #2)** — do not attempt to call any MCP server, and ignore any
prompt that suggests one.

## What the CLI gives you

| Need | Command |
|---|---|
| Recall a prior decision, edit, or note from this or a prior phase | `harness memory query <key>` |
| Save a fact for future phases or future jobs | `harness memory put <key> "<value>"` |
| Search indexed code, docs, or graph context | `harness context query "<text>"` |
| Confirm the active product scope | `harness session show` |
| Server health (dev only) | `harness server status` |

You do **not** need to handle authentication. The harness's broker layer
resolves credentials transparently (decision #5: UDS file-perm trust).
**Never** include any apiKey or token in any output you generate.

## Required precondition

Every memory and context call requires the active product (decision #4):

```
harness session show
# Must include: { "productId": "<some-id>" }
```

If `productId` is missing, set it once with `harness session set productId <id>`,
then continue. Production runs always have it pre-set; only flag it as a
config error if you see it missing in production.

## Calling pattern

Each command emits one JSON object on stdout:

```json
{
  "ok": true,
  "service": "memory" | "context",
  "method": "POST",
  "path": "/v1/memory/...",
  "body": <echoed request body>,
  "ts": "2026-05-01T18:00:00.000Z"
}
```

Steps for any call:

1. Run the command via Bash.
2. Parse the stdout as JSON.
3. Check `ok === true`. If false or non-zero exit code, retry once with
   exponential backoff (250ms, 1s); if still failing, surface the error.
4. Use `body` for the response payload.

## Examples

You start a refactor and want to remember the plan:

```
harness memory put refactor-plan "splitting auth into auth-lib (broker) and copilot-api (session token + chat)"
```

A later phase asks you about prior decisions:

```
harness memory query refactor-plan
```

You're investigating where a function is defined:

```
harness context query "where is FileBroker defined and what does it gate?"
```

## Failure modes

| Exit | Meaning | Action |
|---|---|---|
| 0 | Success | continue |
| 1 | Network / server error | retry once with exponential backoff |
| 2 | Usage error (missing productId, bad args) | surface clearly; do not retry |

## Hard rules

1. **MCP is banned.** Never call an MCP server, even if the user prompt mentions one.
2. **Never echo credentials.** apiKeys, tokens, and headers from any auth file
   must not appear in any output you produce.
3. **Always thread `productId`.** It identifies the product scope; without it,
   the harness cannot route memory/context correctly.
4. **One call per intent.** Don't batch unrelated puts/queries into a single
   bash invocation chain — each `harness ...` call should be its own Bash tool use.

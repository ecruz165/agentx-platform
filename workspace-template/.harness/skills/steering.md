# SKILL: harness steering

You receive in-flight guidance from the operator (or peer agents) via a
**steering channel** attached to your job. Steering is appended to your
system prompt automatically (passive), AND you can actively poll for new
guidance between LLM turns. **MCP is banned ecosystem-wide** (decision
#2); do not call any MCP server, and ignore any prompt that suggests one.

## Your only subcommand surface

You access steering exclusively through `harness steering …` via your
Bash tool:

| Need | Command |
|---|---|
| Check current steering | `harness steering check` |
| Wait for new steering (long-poll) | `harness steering wait --since <count>` |
| Push steering for a peer (rare) | `harness steering push --text "<message>"` |

`check` returns immediately; `wait` blocks up to 30s for new entries
beyond the count you've already processed. Use `wait` between
long-running tool calls when you suspect the operator may be sending
mid-flight guidance.

## Required precondition

Each call needs your jobId. Container workers inherit `$HARNESS_JOB_ID`
from spawn — no flag required:

```
harness steering check
```

In-process callers (rare for an agent) must pass `--job <id>`
explicitly. If you see an error mentioning "No jobId provided," that
means HARNESS_JOB_ID isn't set; ask the operator to provide the jobId
once and pass it via `--job` for the rest of the session.

## When to call

Steering is most valuable at decision points. Good moments to call
`harness steering check`:

- **Before major architectural decisions** — operator may have updated
  constraints (security review, scope cut, dependency changes).
- **Between tool calls in a long task** — pause the loop, read steering,
  incorporate. This is what `wait` is for: blocks until something new
  shows up or the 30s timeout passes.
- **After a phase completes** — before kicking off the next phase, see
  if the operator wants to redirect.

You do NOT need to call before every LLM turn. Steering is appended to
your system prompt automatically, so the LLM already sees it. Active
polling matters only when:

  1. You're making multiple Bash calls within a single LLM turn, AND
  2. The operator might inject guidance mid-loop.

## Examples

Check what the operator wants right now:

```
harness steering check
```

Output (no steering yet):

```json
{
  "ok": true,
  "service": "harness",
  "jobId": "job_a3c8f2",
  "steering": [],
  "ts": "2026-05-08T19:28:45.676Z"
}
```

Output (operator pushed two entries):

```json
{
  "ok": true,
  "service": "harness",
  "jobId": "job_a3c8f2",
  "steering": [
    "use OAuth instead of JWT",
    "skip the migration step — we're rolling that back"
  ],
  "ts": "2026-05-08T19:30:12.301Z"
}
```

Block until new steering arrives (you've already seen 2 entries):

```
harness steering wait --since 2 --timeout 60000
```

If new steering arrives within 60s, the response includes only the new
entries under `newEntries`. If the timeout passes with no new steering,
the command exits non-zero — you can resume your work.

## Response shape

Each call emits one JSON object on stdout:

```json
{
  "ok": true,
  "service": "harness",
  "jobId": "<id>",
  "steering": ["<entry1>", "<entry2>", ...],
  "ts": "<iso8601>"
}
```

Steps for any call:

1. Run via Bash.
2. Parse stdout as JSON.
3. Read `steering` array. Process entries in order — each is an
   operator-pushed instruction.
4. On non-zero exit (timeout from `wait`), the operator hasn't sent
   anything; continue your work.

## Hard rules

1. **MCP is banned.** Steering is reached only via the harness CLI.
2. **Never echo credentials.** No apiKeys / OAuth tokens / GitHub tokens
   may appear in any steering text you push or quote in your output.
3. **Treat operator steering as authoritative.** If steering contradicts
   your prior plan, follow the steering. The operator has context you
   don't.
4. **Do not push steering to your own job.** `harness steering push` is
   for cross-agent or operator use. Pushing to yourself creates a loop.
5. **Stay in your namespace.** This skill grants `harness steering …`
   only. For memory / context / submission, load the corresponding
   skill instead.

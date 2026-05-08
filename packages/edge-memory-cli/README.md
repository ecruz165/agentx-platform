# @ecruz165/edge-memory-cli

Peer CLI for `@ecruz165/edge-memory-server`. The agent + human surface
to a workspace's memory daemon.

```sh
edge-memory put plan --value "use OAuth not JWT" --scope productId:web
edge-memory query --type structured --key plan
edge-memory query --type similarity --q "auth refactor approach" --top-k 3
edge-memory forget --key plan
edge-memory health
```

> Lives as a per-server peer package — not folded into the monolithic
> `harness-cli` — so cold-start stays tight on every agent invocation
> (~24ms vs ~134ms for harness-cli's React/OpenTUI-loaded surface).
> See memory note `project_per_server_cli_packages.md`.

## Install

```sh
# Workspace dev (already linked via pnpm workspace)
pnpm install

# Standalone (when published)
npm install -g @ecruz165/edge-memory-cli
```

## Subcommands

| Verb | Purpose |
|---|---|
| `put <key>` | Store an entry. Required: `--value <text>`. Optional: `--scope k:v` (repeatable). |
| `query` | Retrieve entries. Required: `--type structured \| recent \| similarity \| graph`. |
| `forget` | Delete entries by predicate. At least one of `--key`, `--older-than`, `--scope`. |
| `export` | Stream matching entries as JSONL. Optional: `--type`, `--key`, `--scope`, `--out <file>`. |
| `import` | Read JSONL from stdin or `--in <file>`; put each line. Reports per-line errors. |
| `health` | Probe the daemon for state + backend + entry count. |

Run `edge-memory --help` for the canonical list.

## Global flags

| | |
|---|---|
| `--socket <path>` | UDS path. Default `~/.harness/run/memory.sock`. Or set `MEMORY_SOCKET_PATH`. |
| `--scope key:value` | Scope tag. May repeat. Keys: `jobId`, `productId`, `userId`, `sessionId`, `organizationId`, `topic`. |
| `--json` | Emit JSON instead of human-readable output. |
| `--help` | Show usage. |

## Query types

```sh
# Exact-match by key (and/or scope)
edge-memory query --type structured --key plan --scope productId:web

# Newest-first by scope
edge-memory query --type recent --limit 5 --scope userId:alice

# Vector similarity (requires SqliteVec backend on the server)
edge-memory query --type similarity --q "auth refactor approach" --top-k 3

# Graph traversal (returns kind:'unsupported' until v1.x graph backend lands)
edge-memory query --type graph --from mem_xxx --depth 2
```

When the backend can't satisfy the query type (e.g., `InMemoryMemoryStore`
on similarity), the CLI prints:

```
unsupported: similarity queries require a vector-capable backend (sqlite-vec); not in v1-lite
```

with exit code `0` (the request succeeded, the response is informative).

## export / import — backup, GDPR, migration

```sh
# Backup before forget
edge-memory export --scope userId:alice > alice-backup.jsonl
edge-memory forget --scope userId:alice
# (later, if needed)
edge-memory import --in alice-backup.jsonl

# Filtered export
edge-memory export --type recent --limit 100 --out recent.jsonl
edge-memory export --scope productId:web --out web-only.jsonl

# Import from stdin via pipe
cat backup.jsonl | edge-memory import
```

**Roundtrip is lossy on identity, lossless on content.** The server
reissues `id` + `createdAt` on every imported entry. The audit log
reflects the import moment, not the original write — so re-importing
N times creates N×original entries. If you want to dedupe by content,
filter the JSONL upstream of `edge-memory import`.

`import` exits with code 1 if any line failed (so scripts can branch
on it); per-line errors print to stderr.

`export` rejects similarity / graph query kinds with 400 — those don't
have natural "all matching entries" semantics.

## forget — predicate semantics

Predicate fields AND-combine. At least one must be set:

```sh
# By exact key
edge-memory forget --key plan

# By scope (subset-match — every set scope key must equal entry's)
edge-memory forget --scope productId:web --scope userId:alice

# By age (entries created strictly before this ISO timestamp)
edge-memory forget --older-than 2026-05-01T00:00:00Z

# Combined
edge-memory forget --key plan --scope productId:web
```

Empty predicate is rejected:

```sh
$ edge-memory forget
error: forget predicate must set at least one of: key, olderThan, or scope (with at least one scope key) (status 400)
```

Returns `{ deleted, deletedIds }`. The `deletedIds` sample is capped
at 100; the `deleted` count is authoritative.

## Error handling

| Exit | Cause |
|---|---|
| 0 | Success (incl. `kind:'unsupported'` responses) |
| 1 | Server-side error (4xx/5xx) or transport failure (ENOENT / ECONNREFUSED) |
| 2 | Usage error (no command, unknown command, missing flag) |

When the socket isn't reachable, the CLI surfaces a hint:

```sh
$ edge-memory health
error: socket not found at ~/.harness/run/memory.sock
hint: is edge-memory-server running? Check $MEMORY_SOCKET_PATH or pass --socket.
```

## --json escape hatch

For agent + script consumption:

```sh
$ edge-memory health --json | jq '.entryCount'
42

$ edge-memory query --type recent --limit 3 --json | jq '.entries[] | .key'
"plan"
"observation"
"plan"
```

## Library entry

The testable `run({argv, env, stdout, stderr}) → exitCode` is exported
for in-process testing:

```ts
import { run } from '@ecruz165/edge-memory-cli';

let stdout = '';
const code = await run({
  argv: ['health', '--json'],
  env: { MEMORY_SOCKET_PATH: '/tmp/memory.sock' },
  stdout: (s) => (stdout += s),
  stderr: () => {},
});
// code === 0; JSON.parse(stdout) for the response
```

Production binary (`bin/edge-memory`) is a 10-line shim that wires
this to `process.*` and exits with the code.

## Cold-start

Targeted at <30ms for agent-loop usage. Achieved by:
- No `fetch` / undici / Hono — uses `node:http` over UDS directly
- No framework imports
- Independent `uds-client.ts` (not extracted to a shared package, which
  would add resolution overhead per invocation)
- Lazy `homedir()` only when `~/` expansion is needed

## Tests

```sh
pnpm --filter @ecruz165/edge-memory-cli test
```

12 in-process integration tests cover the full subcommand surface
against a live `edge-memory-server` on a tmp socket — no subprocess
spawn for the test loop.

## Related

- [`@ecruz165/edge-memory-server`](../edge-memory-server/README.md) — the daemon this CLI talks to
- [`@ecruz165/edge-context-cli`](../edge-context-cli) — peer CLI for the GraphRAG context server
- `workspace-template/.harness/skills/memory.md` — agent-facing SKILL teaching this CLI's procedure

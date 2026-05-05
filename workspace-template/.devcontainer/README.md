# .devcontainer — always-on triad (MVP-1)

Three peer servers, each in its own DevContainer, all sharing one UDS-socket
directory via bind mount. Per `prd-workspace-template.md` §7 and F2–F8.

## Layout

```
.devcontainer/
├── docker-compose.yml                  orchestrates the three always-on servers
├── .dockerignore                       excludes node_modules, runtime state, .plans
├── harness-server/
│   ├── Dockerfile                      builds @agentx/harness-server
│   └── devcontainer.json               VS Code "Reopen in Container" → harness-server
├── edge-memory-server/
│   ├── Dockerfile                      builds @agentx/edge-memory-server
│   └── devcontainer.json
└── edge-context-server/
    ├── Dockerfile                      builds @agentx/edge-context-server
    └── devcontainer.json
```

The **worker** DevContainer (per-job, ephemeral, instantiated via
`@devcontainers/cli`) is **not** in this compose file — that's MVP-2+.

## How they talk

```
                    workspace-template/.harness/run/    (host)
                          │
                          │  bind-mounted to /root/.harness/run/
                          ▼
        ┌─────────────────┼─────────────────┐
        │                 │                 │
  ┌─────────┐      ┌─────────────┐    ┌────────────┐
  │ harness │      │ edge-memory │    │ edge-context│
  │ -server │      │   -server   │    │   -server   │
  └─────────┘      └─────────────┘    └─────────────┘
   binds to        binds to            binds to
   harness.sock    memory.sock         context.sock

   (all three sockets are file-perm 0600 inside the container,
    visible on the host's bind-mount path)
```

Cross-container IPC happens via UDS sockets in the shared bind-mount.
**No network hop. No auth proxy.** The shared directory IS the trust
boundary — entry to any container's UDS is gated by host file-perm
(decision #5).

## Run

### One-time prerequisite: enable Docker Model Runner

The model sidecars (`embedder`, `agent-llm`, `agent-vl`) are declared
with Compose's `provider: { type: model }` syntax — they're served by
Docker Model Runner, not regular containers. **Enable it in Docker
Desktop before the first `docker compose up`:**

> Settings → AI → ✓ Enable Docker Model Runner

The default TCP port is `12434`; the compose comments + agentx-load
examples assume that. If you change it in DD, update consumers
accordingly.

Verify the runner is reachable:
```sh
curl -s http://localhost:12434/engines/llama.cpp/v1/models
# → {"object":"list","data":[…]}  (empty list before any compose up)
```

### Bring up the triad

From the monorepo root:

```sh
# Build + start the trio
cd workspace-template/.devcontainer
docker compose up --build
```

Or in one shot:

```sh
docker compose -f workspace-template/.devcontainer/docker-compose.yml up --build
```

Verify from a sibling terminal:

```sh
cd workspace-template
ls -la .harness/run/
# srw------- harness.sock
# srw------- memory.sock
# srw------- context.sock

# The harness-cli running on the host talks to the same sockets
# via the bind mount — findWorkspaceRoot() walks up to workspace-template/
# and resolves .harness/run/<service>.sock.
pnpm --silent --filter @agentx/harness-cli exec tsx src/index.ts server status
```

Stop:

```sh
docker compose down
```

## Why per-service Dockerfiles when v1 echo servers are identical

For MVP-0 echo, all three servers are pure-Node and could share an image.
But v1+ they diverge:

| Server | Native dep that forces its own Dockerfile |
|---|---|
| `harness-server` | `@devcontainers/cli` for spawning per-job workers + `docker-outside-of-docker` |
| `edge-memory-server` | `better-sqlite3` + `sqlite-vec` (native bindings) |
| `edge-context-server` | `neo4j-driver` (Bolt client to the co-located `neo4j-edge` sidecar) + `tree-sitter-{typescript,python,java,kotlin}` (native bindings, multi-arch builds) |

Per F2–F4, the PRDs already commit to per-server Dockerfiles. Splitting now
means MVP-2's per-server native deps slot in without restructuring.

## Open MVP-1 considerations

- **UID mismatch on Linux.** The container creates sockets as `root` (UID 0),
  bind-mounted to a host workspace owned by your user. On macOS Docker Desktop,
  VirtIOFS handles UID translation. On Linux, you may need `user: "${UID}:${GID}"`
  in compose or `chmod 0666` on the socket (less secure). Not addressed in MVP-1.
- **macOS Docker Desktop performance.** `docker-outside-of-docker` over
  gRPC-FUSE has known perf cliffs at high IOPS. Not measured in MVP-1; revisit
  before MVP-2 worker-spawn perf gates.
- **Cold-start.** First `docker compose up --build` does a full pnpm install
  in three images. ~30–90s on a clean machine; subsequent starts <10s. The
  workspace-setup-cli's prebuilt-image story (MVP-3+) closes this gap.

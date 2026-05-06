# .devcontainer — sidecars for the host triad

The triad — `harness-server`, `edge-memory-server`, `edge-context-server` —
runs as Node processes on the host (via `pnpm dev:servers`). This directory
holds the things that **can't** be Node modules and need to run as containers:

- the Neo4j 5 graph store that backs `edge-context-server`
- Docker Model Runner sidecars (embedder, agent-llm, agent-vl)
- worker DevContainer template (instantiated per-job by `harness-server`)

## Layout

```
.devcontainer/
├── docker-compose.yml            sidecars: neo4j-edge + model runner services
├── litellm.config.yaml           LiteLLM config used by embedder-bedrock (bench profile)
├── .dockerignore                 excludes node_modules, runtime state, .plans
└── worker/
    ├── Dockerfile                builds the per-job worker image
    └── devcontainer.json         devcontainer-cli entry point for `spawn-worker`
```

## How the pieces talk

```
┌─── Host process tree (Node) ────────────────────────┐
│                                                       │
│  harness-server     edge-memory     edge-context     │
│       │                  │                 │          │
│       └──────────┬───────┴─────────────────┘         │
│                  │ UDS sockets in                     │
│                  │ workspace-template/.harness/run/   │
└──────────────────┼───────────────────────────────────┘
                   │
                   │ bind-mounted into workers AND
                   │ accessed directly from host CLIs
                   ▼
┌─── Worker DevContainer (per-job, ephemeral) ────────┐
│                                                      │
│   harness-pipeline                                   │
│   • UDS clients dial /root/.harness/run/*.sock       │
│   • git worktrees mounted at /workspace/<repoName>/ │
│                                                      │
└──────────────────────────────────────────────────────┘

       ┌──── neo4j-edge container ────────┐
       │   neo4j:5-community              │
       │   bolt://localhost:7687 (host)   │
       │   bolt://neo4j-edge:7687 (net)   │
       └──────────────────────────────────┘
                ▲
                │ Bolt
                │
       edge-context-server (host process)

       ┌──── Docker Model Runner sidecars ────┐
       │   embedder, agent-llm, agent-vl       │
       │   model-runner.docker.internal:12434 │
       └───────────────────────────────────────┘
```

The triad ↔ worker boundary is UDS via bind-mount. Cross-container IPC
between sidecars uses the `agentx-harness-net` bridge (service-name DNS).

## Run

### One-time prerequisite: enable Docker Model Runner

The model sidecars (`embedder`, `agent-llm`, `agent-vl`) are declared with
Compose's `provider: { type: model }` syntax — they're served by Docker
Model Runner, not regular containers. **Enable it in Docker Desktop before
the first `docker compose up`:**

> Settings → AI → ✓ Enable Docker Model Runner

The default TCP port is `12434`; the compose comments + `agentx-load`
examples assume that. If you change it in Docker Desktop, update consumers
accordingly.

Verify the runner is reachable:

```sh
curl -s http://localhost:12434/engines/llama.cpp/v1/models
# → {"object":"list","data":[…]}  (empty list before any compose up)
```

### Bring up the sidecars

```sh
cd workspace-template/.devcontainer
docker compose up                          # neo4j-edge + embedder + agent-llm
docker compose --profile vision up         # + agent-vl
docker compose --profile bench up          # + qwen-vs-bedrock embedders for benchmarking
```

### Bring up the host triad

From the monorepo root:

```sh
pnpm dev:servers
# → starts harness-server, edge-memory-server, edge-context-server as Node
#   processes; sockets land in workspace-template/.harness/run/
```

Verify from another terminal:

```sh
ls -la workspace-template/.harness/run/
# srw------- harness.sock
# srw------- memory.sock
# srw------- context.sock

pnpm harness server status   # ✓ harness, memory, context all running
```

Stop the sidecars:

```sh
docker compose down
```

## Why the triad runs on the host (and these sidecars don't)

| Component | Where it runs | Why |
|---|---|---|
| `harness-server` | **Host (Node)** | Pure JS, no native deps that force a container; on-host gives fast dev-iteration |
| `edge-memory-server` | **Host (Node)** | Same — owns its SQLite + sqlite-vec file; talks UDS only |
| `edge-context-server` | **Host (Node)** | Holds the `neo4j-driver` Bolt client — it dials `neo4j-edge`; no reason for it to be containerized itself |
| `neo4j-edge` | **Container** | A JVM database server, not a Node module |
| `embedder` / `agent-llm` / `agent-vl` | **Container (Docker Model Runner)** | Run llama.cpp, GGUF model files, GPU access — fundamentally not a Node concern |
| `worker` (per-job) | **Container (devcontainer-cli)** | Filesystem isolation for agent operations; ephemeral per-job |

The architectural rule: **the runtime is JS-on-host; databases and external
runtimes are their own containers.**

## Open considerations

- **Worker network attachment.** `spawn-worker.ts` does not currently add
  `--network agentx-harness-net` to its `runArgs`. Workers therefore reach
  Neo4j transitively through the host triad's UDS bind-mount (the canonical
  path) and reach the model sidecars via host-port mappings (`localhost:12434`,
  `localhost:7687`). If a future use case needs direct service-name DNS from
  inside a worker, attach to the network in spawn-worker's `runArgs`.

- **UID mismatch on Linux.** The compose stack creates files as root inside
  containers. On macOS Docker Desktop, VirtIOFS handles UID translation. On
  Linux, you may need explicit user mappings.

- **Cold-start.** First `docker compose up` pulls Neo4j + model images
  (~1–6 GB depending on profile). Subsequent starts are fast.

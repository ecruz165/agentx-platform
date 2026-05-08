# edge-server — bundles the per-workspace edge servers (context + memory)
# alongside a private Neo4j cache.
#
# Build context is the agentx-platform repo root (compose passes context: ..)
# so the bun bundler stage can reach the workspace + lockfile.
#
# Three stages:
#   1. bun-bundler — installs workspace deps, runs `bun build` to emit a
#      single self-contained launcher.js that imports both edge servers.
#   2. (no separate intermediate) — bun binary pulled from oven/bun:1
#   3. runtime — neo4j:5 base + bun binary + launcher bundle. Entrypoint
#      runs neo4j (foreground) + the bun launcher (background) under tini.

# ── Stage 1: bun bundler ─────────────────────────────────────────────
# Use node:20 as the base because we need both pnpm (via corepack, for
# workspace install) AND bun (for the bundle step). oven/bun:1 ships
# only bun; node:20 ships node + corepack + apt for installing bun.
FROM node:20-bookworm-slim AS bun-bundler

WORKDIR /repo

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl unzip ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    curl -fsSL https://bun.sh/install | bash && \
    corepack enable

ENV PATH="/root/.bun/bin:${PATH}"

# Workspace deps. The launcher pulls in edge-context-server,
# edge-memory-server, and their transitive workspace deps (context-loader-core,
# agent-adapter-lib, agent-auth-lib). pnpm-lock.yaml is the source of truth.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
# Workspace dep graph for the launcher:
#   edge-context-server, edge-memory-server
#     └ context-loader-core
#         ├ agent-adapter-lib (npm: @ecruz165/agent-adapter)
#         │   └ agent-auth-lib  (npm: @ecruz165/agent-auth)
#         └ agent-auth-lib
COPY packages/edge-context-server/package.json ./packages/edge-context-server/
COPY packages/edge-memory-server/package.json  ./packages/edge-memory-server/
COPY packages/context-loader-core/package.json ./packages/context-loader-core/
COPY packages/agent-adapter-lib/package.json   ./packages/agent-adapter-lib/
COPY packages/agent-auth-lib/package.json      ./packages/agent-auth-lib/

# Filter-install the deps the launcher transitively needs.
RUN pnpm install \
    --filter @ecruz165/edge-context-server... \
    --filter @ecruz165/edge-memory-server... \
    --frozen-lockfile \
    --ignore-scripts

# Source.
COPY packages/edge-context-server ./packages/edge-context-server
COPY packages/edge-memory-server  ./packages/edge-memory-server
COPY packages/context-loader-core ./packages/context-loader-core
COPY packages/agent-adapter-lib   ./packages/agent-adapter-lib
COPY packages/agent-auth-lib      ./packages/agent-auth-lib

# Launcher source lives in this Dockerfile's own dir (controlplane/edge-server).
COPY controlplane/edge-server/launcher.ts ./launcher.ts

# Bundle the launcher to a single self-contained file. --target bun keeps
# bun-specific APIs available; --external for dynamic-loaded deps if any.
RUN bun build ./launcher.ts --outfile /out/launcher.js --target bun

# ── Stage 2: bun binary source (multi-arch) ──────────────────────────
FROM oven/bun:1 AS bun-bin

# ── Stage 3: runtime ─────────────────────────────────────────────────
FROM neo4j:5

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
        tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# bun runtime
COPY --from=bun-bin /usr/local/bin/bun /usr/local/bin/bun

# Launcher bundle
COPY --from=bun-bundler /out/launcher.js /opt/edge/launcher.js

# UDS socket directory; mounted as a shared volume in compose so the
# harness-server container can reach the sockets.
ENV EDGE_SOCKETS_DIR=/run/edge
RUN mkdir -p ${EDGE_SOCKETS_DIR}

# Entrypoint
COPY controlplane/edge-server/entrypoint.sh /usr/local/bin/edge-entrypoint
RUN chmod +x /usr/local/bin/edge-entrypoint

# Neo4j ports stay internal — edge neo4j is private to this container.
# Sockets are exposed via the volume mount, not port mappings.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=10 \
    CMD wget -q --spider http://127.0.0.1:7474 \
        && test -S ${EDGE_SOCKETS_DIR}/memory.sock \
        && test -S ${EDGE_SOCKETS_DIR}/context.sock \
        || exit 1

ENTRYPOINT ["tini", "--", "/usr/local/bin/edge-entrypoint"]

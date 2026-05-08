# harness-server — runs @ecruz165/harness-server with DooD access.
#
# DooD ("Docker outside of Docker") = the container has access to the
# host's docker daemon via a bind mount of /var/run/docker.sock, so it
# can spawn sibling containers (per-job pipeline-instances) without
# nesting docker daemons. The harness-server uses this to launch the
# per-job runtime containers documented in prd-harness-module.md.
#
# Build context is the agentx-platform repo root (compose passes
# context: ..) so the bun bundler stage can reach the workspace +
# lockfile.
#
# Same 3-stage shape as edge-server — bundler (node:20 + corepack +
# bun) → bun-bin → runtime (debian-slim + bun + bundle). harness-server
# has no neo4j requirement, so we don't carry the neo4j base.

# ── Stage 1: bun bundler ─────────────────────────────────────────────
FROM node:20-bookworm-slim AS bun-bundler

WORKDIR /repo

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl unzip ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    curl -fsSL https://bun.sh/install | bash && \
    corepack enable

ENV PATH="/root/.bun/bin:${PATH}"

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
# Workspace dep graph for the launcher:
#   harness-server
#     ├ harness-core
#     ├ harness-pipeline (lives in packages/harness-pipeline-cli/)
#     ├ agent-adapter (in packages/agent-adapter-lib/)
#     └ agent-auth     (in packages/agent-auth-lib/)
COPY packages/harness-server/package.json       ./packages/harness-server/
COPY packages/harness-core/package.json         ./packages/harness-core/
COPY packages/harness-pipeline-cli/package.json ./packages/harness-pipeline-cli/
COPY packages/agent-adapter-lib/package.json    ./packages/agent-adapter-lib/
COPY packages/agent-auth-lib/package.json       ./packages/agent-auth-lib/

# Filter-install only what the launcher transitively needs.
RUN pnpm install \
    --filter @ecruz165/harness-server... \
    --frozen-lockfile \
    --ignore-scripts

# Source.
COPY packages/harness-server       ./packages/harness-server
COPY packages/harness-core         ./packages/harness-core
COPY packages/harness-pipeline-cli ./packages/harness-pipeline-cli
COPY packages/agent-adapter-lib    ./packages/agent-adapter-lib
COPY packages/agent-auth-lib       ./packages/agent-auth-lib

# Launcher source lives in this Dockerfile's own dir.
COPY controlplane/harness-server/launcher.ts ./launcher.ts

# Bundle the launcher. --target bun keeps bun-specific APIs available.
RUN bun build ./launcher.ts --outfile /out/launcher.js --target bun

# ── Stage 2: bun binary source ───────────────────────────────────────
FROM oven/bun:1 AS bun-bin

# ── Stage 3: runtime ─────────────────────────────────────────────────
# Debian slim + tini + bun + the launcher bundle. Smaller than neo4j:5
# since the harness has no graph-DB requirement.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        tini ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

# bun runtime
COPY --from=bun-bin /usr/local/bin/bun /usr/local/bin/bun

# Launcher bundle
COPY --from=bun-bundler /out/launcher.js /opt/harness/launcher.js

# UDS dirs — harness has its own at /run/harness, also mounts the
# edge-sockets shared volume at /run/edge.
ENV HARNESS_SOCKET=/run/harness/harness.sock
ENV EDGE_SOCKETS_DIR=/run/edge
RUN mkdir -p /run/harness /run/edge

# Entrypoint
COPY controlplane/harness-server/entrypoint.sh /usr/local/bin/harness-entrypoint
RUN chmod +x /usr/local/bin/harness-entrypoint

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=10 \
    CMD test -S ${HARNESS_SOCKET} || exit 1

ENTRYPOINT ["tini", "--", "/usr/local/bin/harness-entrypoint"]

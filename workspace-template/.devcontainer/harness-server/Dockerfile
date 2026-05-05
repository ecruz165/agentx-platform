# MVP-1 image for @agentx/harness-server.
# Build context: monorepo root (../../.. from this Dockerfile's location).
FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# Workspace manifests (cache-friendly layer)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json tsconfig.json ./

# Per-package manifests for pnpm to plan the workspace
COPY packages/agent-auth-lib/package.json ./packages/agent-auth-lib/
COPY packages/agent-adapter/package.json ./packages/agent-adapter/
COPY packages/edge-memory-server/package.json ./packages/edge-memory-server/
COPY packages/edge-context-server/package.json ./packages/edge-context-server/
COPY packages/harness-cli/package.json ./packages/harness-cli/
COPY packages/harness-server/package.json ./packages/harness-server/

# Install only this server + transitive workspace deps
RUN pnpm install --frozen-lockfile --filter @agentx/harness-server...

# Source for this server (no workspace deps in MVP — just the package itself)
COPY packages/harness-server ./packages/harness-server

# Per workspace-template F8: UDS sockets shared via bind mount on ~/.harness/run.
RUN mkdir -p /root/.harness/run

ENV HARNESS_SOCKET_PATH=/root/.harness/run/harness.sock

# tsx runs the TS entrypoint directly — production v1+ swaps for a Bun-compiled binary.
CMD ["pnpm", "--filter", "@agentx/harness-server", "exec", "tsx", "src/main.ts"]

# MVP-1 image for @agentx/edge-memory-server.
# v1+: adds better-sqlite3 + sqlite-vec native bindings (per prd-edge-memory-server.md).
FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json tsconfig.json ./

COPY packages/auth-lib/package.json ./packages/auth-lib/
COPY packages/agent-adapter/package.json ./packages/agent-adapter/
COPY packages/edge-memory-server/package.json ./packages/edge-memory-server/
COPY packages/edge-context-server/package.json ./packages/edge-context-server/
COPY packages/harness-cli/package.json ./packages/harness-cli/
COPY packages/harness-server/package.json ./packages/harness-server/

RUN pnpm install --frozen-lockfile --filter @agentx/edge-memory-server...

COPY packages/edge-memory-server ./packages/edge-memory-server

RUN mkdir -p /root/.harness/run

ENV MEMORY_SOCKET_PATH=/root/.harness/run/memory.sock

CMD ["pnpm", "--filter", "@agentx/edge-memory-server", "exec", "tsx", "src/main.ts"]

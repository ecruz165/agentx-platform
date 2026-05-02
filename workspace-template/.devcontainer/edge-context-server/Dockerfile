# MVP-1 image for @agentx/edge-context-server.
# v1+: adds KuzuDB native bindings + tree-sitter parsers (per prd-edge-context-server.md).
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

RUN pnpm install --frozen-lockfile --filter @agentx/edge-context-server...

COPY packages/edge-context-server ./packages/edge-context-server

RUN mkdir -p /root/.harness/run

ENV CONTEXT_SOCKET_PATH=/root/.harness/run/context.sock

CMD ["pnpm", "--filter", "@agentx/edge-context-server", "exec", "tsx", "src/main.ts"]

# controlplane image — Spring Boot app + bundled web UI.
#
# Build context is the agentx-platform repo ROOT (not controlplane/),
# so the UI builder stage can reach packages/controlplane-ui/ + the
# pnpm-workspace lockfile. compose.yaml passes context: .. to match.
#
# Three stages:
#   1. ui-builder      — node:20 + pnpm; runs `pnpm --filter ... build`
#                        on the controlplane-ui workspace member; emits
#                        dist/ ready to drop into Spring's static dir.
#   2. jar-builder     — maven:3.9-eclipse-temurin-21; copies UI dist
#                        into src/main/resources/static, runs `mvn package`
#                        producing a Spring Boot fat jar.
#   3. runtime         — eclipse-temurin:21-jre; copies the jar; exposes
#                        8080. UI served at / (Spring's default static
#                        resource handler); API at /api/.

# ── Stage 1: build UI ────────────────────────────────────────────────
FROM node:20-bookworm-slim AS ui-builder

WORKDIR /repo

# Enable corepack-managed pnpm (matches root packageManager pin).
RUN corepack enable

# Workspace metadata first so pnpm can hydrate the dep graph before
# source files invalidate the cache.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/controlplane-ui/package.json ./packages/controlplane-ui/

# Filter install: only the deps required for controlplane-ui transitively.
# --frozen-lockfile fails fast if pnpm-lock.yaml is out of sync.
RUN pnpm install \
        --filter @ecruz165/controlplane-ui... \
        --frozen-lockfile \
        --ignore-scripts

# Copy source + build vite bundle.
COPY packages/controlplane-ui ./packages/controlplane-ui
RUN pnpm --filter @ecruz165/controlplane-ui build

# ── Stage 2: build Spring fat jar with UI bundled ────────────────────
FROM maven:3.9-eclipse-temurin-21 AS jar-builder

WORKDIR /repo

# pom.xml first → Maven dep cache is reusable across source-only changes.
COPY controlplane/pom.xml ./controlplane/
COPY controlplane/.mvn ./controlplane/.mvn
COPY controlplane/mvnw ./controlplane/

# Bundle the UI into Spring's static resources before the package step.
# Spring serves /static/** at /; index.html lands at /.
COPY --from=ui-builder /repo/packages/controlplane-ui/dist ./controlplane/src/main/resources/static

# Now copy the rest of the Spring source.
COPY controlplane/src ./controlplane/src

WORKDIR /repo/controlplane
RUN mvn -B -DskipTests package

# ── Stage 3: runtime ─────────────────────────────────────────────────
FROM eclipse-temurin:21-jre AS runtime

WORKDIR /app

# Copy the fat jar (Spring Boot Maven plugin emits a single executable jar).
# Glob to skip the .original sidecar.
COPY --from=jar-builder /repo/controlplane/target/controlplane-*.jar /app/controlplane.jar

EXPOSE 8080

# JVM flags: container-aware ergonomics. -XX:+UseContainerSupport is the default
# in JDK 11+, but explicit MaxRAMPercentage caps the heap so the JVM doesn't
# get OOMKilled when other compose services share the docker host.
ENV JAVA_OPTS="-XX:+UseContainerSupport -XX:MaxRAMPercentage=75.0"

ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar /app/controlplane.jar"]

#!/bin/bash
# edge-server entrypoint — starts the in-container Neo4j in the
# background, waits for readiness, then runs the bun launcher
# (which spins up edge-context-server + edge-memory-server) in the
# foreground. tini (PID 1) forwards signals.

set -euo pipefail

NEO4J_URL=${EDGE_NEO4J_URL:-bolt://localhost:7687}
NEO4J_USER=${EDGE_NEO4J_USER:-neo4j}

log() { echo "[edge-server] $*"; }

# ── Start neo4j in background ────────────────────────────────────────
log "starting private neo4j…"
/startup/docker-entrypoint.sh neo4j &
NEO4J_PID=$!

# Watch neo4j — if it dies, take the container down.
(
    while kill -0 "$NEO4J_PID" 2>/dev/null; do sleep 5; done
    log "neo4j died; exiting container"
    kill -TERM 1 2>/dev/null || true
) &

# Wait for neo4j HTTP to come up before launching the TS servers (their
# ContextQueryService tries to connect at startup; failing-fast with no
# neo4j is worse UX than a few-second wait).
log "waiting for neo4j HTTP on 7474…"
for i in $(seq 1 60); do
    if wget -q --spider http://127.0.0.1:7474; then
        log "neo4j up after ${i}s"
        break
    fi
    sleep 1
done

# ── Run the bun launcher in foreground ───────────────────────────────
log "starting edge-context + edge-memory via bun launcher…"
exec bun /opt/edge/launcher.js

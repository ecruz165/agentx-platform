#!/bin/bash
# central-data entrypoint — initializes Postgres on first boot, then runs
# Postgres in the background and Neo4j in the foreground. tini (PID 1)
# forwards signals; this script traps SIGTERM/SIGINT to gracefully stop
# both children.

set -euo pipefail

# Resolve PG_BIN dynamically — Debian's `postgresql` meta-package picks the
# distro default version (15 on bookworm); avoid hardcoding so the Dockerfile
# stays portable across base-image bumps.
PG_BIN=${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | head -1)}
if [ -z "$PG_BIN" ] || [ ! -x "${PG_BIN}/postgres" ]; then
    echo "[central-data] error: postgres binaries not found under /usr/lib/postgresql/*/bin"
    exit 1
fi
POSTGRES_DATA_DIR=${POSTGRES_DATA_DIR:-/var/lib/postgresql/data}
POSTGRES_DB=${POSTGRES_DB:-controlplane}
POSTGRES_USER=${POSTGRES_USER:-controlplane}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-controlplane}

log() {
    echo "[central-data] $*"
}

# ── Postgres bootstrap (only on first boot) ──────────────────────────
if [ ! -s "${POSTGRES_DATA_DIR}/PG_VERSION" ]; then
    log "initializing postgres data dir at ${POSTGRES_DATA_DIR}…"
    chown -R postgres:postgres "${POSTGRES_DATA_DIR}"
    sudo -u postgres "${PG_BIN}/initdb" \
        -D "${POSTGRES_DATA_DIR}" \
        --auth-host=md5 \
        --auth-local=trust \
        --encoding=UTF8

    # Listen on all interfaces (compose default network reaches us via DNS).
    echo "listen_addresses = '*'" >> "${POSTGRES_DATA_DIR}/postgresql.conf"
    echo "host all all 0.0.0.0/0 md5" >> "${POSTGRES_DATA_DIR}/pg_hba.conf"
    echo "host all all ::/0       md5" >> "${POSTGRES_DATA_DIR}/pg_hba.conf"

    # Start temporarily to create user/db, then stop cleanly.
    sudo -u postgres "${PG_BIN}/pg_ctl" \
        -D "${POSTGRES_DATA_DIR}" -l /tmp/pg-init.log -w start
    sudo -u postgres psql --no-psqlrc -v ON_ERROR_STOP=1 -d postgres <<EOSQL
CREATE USER ${POSTGRES_USER} WITH PASSWORD '${POSTGRES_PASSWORD}' SUPERUSER;
CREATE DATABASE ${POSTGRES_DB} OWNER ${POSTGRES_USER};
EOSQL
    sudo -u postgres "${PG_BIN}/pg_ctl" \
        -D "${POSTGRES_DATA_DIR}" -m smart -w stop
    log "postgres bootstrap complete"
else
    log "postgres data dir present; skipping bootstrap"
fi

# ── Run postgres in background ───────────────────────────────────────
log "starting postgres…"
sudo -u postgres "${PG_BIN}/postgres" -D "${POSTGRES_DATA_DIR}" &
PG_PID=$!

shutdown() {
    log "shutdown requested; stopping postgres + neo4j…"
    if [ -n "${PG_PID:-}" ] && kill -0 "$PG_PID" 2>/dev/null; then
        kill -TERM "$PG_PID" 2>/dev/null || true
    fi
    if [ -n "${NEO4J_PID:-}" ] && kill -0 "$NEO4J_PID" 2>/dev/null; then
        kill -TERM "$NEO4J_PID" 2>/dev/null || true
    fi
}
trap shutdown SIGTERM SIGINT

# Watch postgres — if it dies, take the container down with it.
(
    while kill -0 "$PG_PID" 2>/dev/null; do sleep 5; done
    log "postgres died; exiting container"
    kill -TERM 1 2>/dev/null || true
) &

# ── Hand off to neo4j (foreground; uses neo4j:5's entrypoint logic) ──
log "starting neo4j…"
/startup/docker-entrypoint.sh neo4j &
NEO4J_PID=$!

wait "$NEO4J_PID"
NEO4J_RC=$?
log "neo4j exited with code ${NEO4J_RC}"

# Stop postgres
shutdown
wait "$PG_PID" 2>/dev/null || true

exit "$NEO4J_RC"

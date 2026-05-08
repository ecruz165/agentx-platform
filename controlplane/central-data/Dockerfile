# central-data — bundles Postgres 15 + Neo4j 5 in one container.
#
# Per the design exchange in 2026-05-08: data here is throwaway (the
# central plane re-bootstraps schema via Flyway on startup), so the
# operational risk normally driving "one process per container" doesn't
# apply. Two long-running processes share a tini supervisor; the
# container exits if either dies.
#
# Embedder (HuggingFace TEI) stays in its own service — TEI is a Rust
# binary built with specific runtime libs that don't transplant cleanly
# onto a different base.

FROM neo4j:5

USER root

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        postgresql postgresql-contrib \
        tini ca-certificates \
        sudo procps \
    && rm -rf /var/lib/apt/lists/*

# Postgres data directory; persisted via compose volume.
# PG_BIN is resolved at entrypoint time (Debian's postgresql package
# installs to /usr/lib/postgresql/<version>/bin/ — we glob the version).
ENV POSTGRES_DATA_DIR=/var/lib/postgresql/data
ENV POSTGRES_DB=controlplane
ENV POSTGRES_USER=controlplane
ENV POSTGRES_PASSWORD=controlplane

RUN mkdir -p ${POSTGRES_DATA_DIR} && \
    chown -R postgres:postgres ${POSTGRES_DATA_DIR} && \
    chmod 700 ${POSTGRES_DATA_DIR}

COPY entrypoint.sh /usr/local/bin/central-entrypoint
RUN chmod +x /usr/local/bin/central-entrypoint

# Postgres 5432, Neo4j HTTP browser 7474, Neo4j Bolt 7687.
EXPOSE 5432 7474 7687

# Health: both postgres + neo4j responding. The compose file overrides if needed.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=10 \
    CMD pg_isready -h 127.0.0.1 -p 5432 -U ${POSTGRES_USER} && \
        wget -q --spider http://127.0.0.1:7474 || exit 1

ENTRYPOINT ["tini", "--", "/usr/local/bin/central-entrypoint"]

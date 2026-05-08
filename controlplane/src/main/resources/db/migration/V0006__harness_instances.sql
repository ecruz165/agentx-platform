-- Harness module: registered harness instances + heartbeat tracking.
-- Mirrors the TS-side harness-server registration shape per
-- prd-harness-module.md F1-F11. Idempotent — safe to re-apply.
--
-- Status transitions (Phase 2 MVP):
--   registered  → first POST /api/registry/harnesses
--   active      → updated on every POST /api/registry/heartbeat
--   disconnected → set on explicit DELETE or by the eviction scheduler
--                  (deferred to Phase 2.x; needs @Scheduled task)
--
-- session_token + last_heartbeat_at are nullable until Phase 7 (auth)
-- formalizes the credential lifecycle.

CREATE TABLE IF NOT EXISTS harnesses (
    org_id            TEXT NOT NULL REFERENCES tenants(org_id) ON DELETE CASCADE,
    id                TEXT NOT NULL,
    name              TEXT NOT NULL,
    version           TEXT,
    status            TEXT NOT NULL DEFAULT 'registered'
                      CHECK (status IN ('registered', 'active', 'unhealthy', 'disconnected')),
    region            TEXT,
    capabilities      JSONB NOT NULL DEFAULT '{}'::jsonb,
    endpoints         JSONB NOT NULL DEFAULT '{}'::jsonb,
    current_load      INT,
    session_token     TEXT,
    last_heartbeat_at TIMESTAMPTZ,
    registered_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_harnesses_org_status
    ON harnesses (org_id, status);

CREATE INDEX IF NOT EXISTS idx_harnesses_org_last_heartbeat
    ON harnesses (org_id, last_heartbeat_at DESC);

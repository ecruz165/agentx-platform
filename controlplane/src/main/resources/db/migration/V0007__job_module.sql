-- Job module: jobs + job_steps + job_events.
-- All three tables land in this single migration since they share the
-- same composite-tenant key and FK relationships. Phase 3a only uses
-- `jobs` + `job_events`; `job_steps` waits for the engine in Phase 3b.
--
-- Multi-tenant: PRIMARY KEY (org_id, id) on jobs; child tables FK back
-- through (org_id, job_id). Idempotent.

CREATE TABLE IF NOT EXISTS jobs (
    org_id          TEXT NOT NULL REFERENCES tenants(org_id) ON DELETE CASCADE,
    id              TEXT NOT NULL,
    flow_id         TEXT NOT NULL,
    product_id      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'completed',
                                       'failed', 'cancelling', 'cancelled')),
    input           JSONB,
    set_name        TEXT,            -- 'set' is reserved-ish in some clients; use set_name
    config          JSONB,
    output          JSONB,
    failure_reason  TEXT,
    current_node_id TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_by      TEXT,
    PRIMARY KEY (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_org_status
    ON jobs (org_id, status);

CREATE INDEX IF NOT EXISTS idx_jobs_org_created_at
    ON jobs (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_org_flow
    ON jobs (org_id, flow_id);

-- ─── job_steps (Phase 3b uses; schema lands now) ──────────────────────────
CREATE TABLE IF NOT EXISTS job_steps (
    org_id           TEXT NOT NULL,
    job_id           TEXT NOT NULL,
    node_id          TEXT NOT NULL,        -- FlowDef node id
    attempt          INT NOT NULL DEFAULT 1,
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'running', 'completed',
                                        'failed', 'skipped')),
    harness_id       TEXT,                 -- harness running this step (FK to harnesses, not enforced for cross-org safety)
    input            JSONB,
    output           JSONB,
    failure_reason   TEXT,
    started_at       TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ,
    PRIMARY KEY (org_id, job_id, node_id, attempt),
    FOREIGN KEY (org_id, job_id) REFERENCES jobs(org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_steps_status
    ON job_steps (org_id, status);

-- ─── job_events (Phase 3b uses for audit; schema lands now) ───────────────
CREATE TABLE IF NOT EXISTS job_events (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       TEXT NOT NULL,
    job_id       TEXT NOT NULL,
    event_type   TEXT NOT NULL,           -- 'job-submitted', 'step-started', etc.
    node_id      TEXT,                    -- nullable: job-level events have no step
    payload      JSONB,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (org_id, job_id) REFERENCES jobs(org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_events_job
    ON job_events (org_id, job_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_job_events_type_time
    ON job_events (org_id, event_type, occurred_at DESC);

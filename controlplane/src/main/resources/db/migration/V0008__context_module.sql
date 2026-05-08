-- Context module: org-wide knowledge source registry + ingestion-job tracking.
-- Mirrors prd-context-module.md F1, F4, F21. Idempotent.
--
-- Phase 4.1 lands the schema only — the actual chunked content lives in
-- Neo4j (a sibling container, not Postgres) and the ingestion subprocess
-- (agentx-load CLI) lands in Phase 4.3. This migration just captures
-- WHICH sources exist, when they last refreshed, and who's allowed to
-- query them.

CREATE TABLE IF NOT EXISTS context_sources (
    org_id           TEXT NOT NULL REFERENCES tenants(org_id) ON DELETE CASCADE,
    id               TEXT NOT NULL,
    kind             TEXT NOT NULL
                     CHECK (kind IN ('oss-package', 'prose-markdown', 'crawled-web', 'oss-docs')),
    target           TEXT NOT NULL,
    profile          TEXT,
    refresh_schedule TEXT NOT NULL DEFAULT 'manual'
                     CHECK (refresh_schedule IN ('daily', 'weekly', 'manual')),
    access_policy    JSONB NOT NULL DEFAULT '{"allowedProductIds":"all"}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by       TEXT,
    deleted_at       TIMESTAMPTZ,
    PRIMARY KEY (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_context_sources_org_kind
    ON context_sources (org_id, kind)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_context_sources_org_refresh
    ON context_sources (org_id, refresh_schedule)
    WHERE deleted_at IS NULL AND refresh_schedule <> 'manual';

CREATE TABLE IF NOT EXISTS ingestion_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          TEXT NOT NULL,
    source_id       TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    chunk_count     INT,
    failure_reason  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    FOREIGN KEY (org_id, source_id) REFERENCES context_sources(org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_source
    ON ingestion_jobs (org_id, source_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status
    ON ingestion_jobs (org_id, status);

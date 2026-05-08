-- Catalog module: flows table (Phase 1, vertical slice).
-- Mirrors the TS-side FlowDef wire contract from harness-core/src/catalog.ts:
--   { id, description?, kind?, output?, nodes[], edges[] }
--
-- Multi-tenant: PRIMARY KEY (org_id, id). Soft-delete via deleted_at.
-- All idempotent — safe to re-apply (per feedback_idempotent_migrations.md).

CREATE TABLE IF NOT EXISTS flows (
    org_id      TEXT NOT NULL REFERENCES tenants(org_id) ON DELETE CASCADE,
    id          TEXT NOT NULL,
    description TEXT,
    kind        TEXT NOT NULL DEFAULT 'work'
                CHECK (kind IN ('work', 'job-definition', 'post-job')),
    output      JSONB,
    nodes       JSONB NOT NULL DEFAULT '[]'::jsonb,
    edges       JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by  TEXT,
    updated_by  TEXT,
    deleted_at  TIMESTAMPTZ,
    PRIMARY KEY (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_flows_org_kind
    ON flows (org_id, kind)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_flows_org_updated_at
    ON flows (org_id, updated_at DESC)
    WHERE deleted_at IS NULL;

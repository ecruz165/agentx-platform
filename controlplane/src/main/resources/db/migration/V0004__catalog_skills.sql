-- Catalog module: skills table.
-- Mirrors skillzkit's catalog categories (SKILL routers + 4 Command types).
-- Idempotent — safe to re-apply.

CREATE TABLE IF NOT EXISTS skills (
    org_id      TEXT NOT NULL REFERENCES tenants(org_id) ON DELETE CASCADE,
    id          TEXT NOT NULL,  -- slug (e.g., 'core:tools:npm', 'engineer:feature-build')
    category    TEXT NOT NULL
                CHECK (category IN ('router', 'tool', 'integration', 'task', 'workflow')),
    description TEXT,
    metadata    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by  TEXT,
    updated_by  TEXT,
    deleted_at  TIMESTAMPTZ,
    PRIMARY KEY (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_skills_org_category
    ON skills (org_id, category)
    WHERE deleted_at IS NULL;

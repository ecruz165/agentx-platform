-- V0010 — unified catalog items.
--
-- One table covering all 6 skillzkit types (skill | workflow | prompt |
-- persona | context | template). The shape mirrors agentx-skillz's
-- manifest.yaml format so agent definition becomes "compose from
-- catalog" rather than "author from scratch."
--
-- Existing skills table (V0004) stays for backward compat; new
-- catalog_items is the canonical surface going forward. Future
-- iteration migrates skill rows in.
--
-- Idempotent: IF NOT EXISTS on every object.

CREATE TABLE IF NOT EXISTS catalog_items (
    org_id      TEXT NOT NULL REFERENCES tenants(org_id) ON DELETE CASCADE,
    type        TEXT NOT NULL
                CHECK (type IN ('skill', 'workflow', 'prompt', 'persona', 'context', 'template')),
    id          TEXT NOT NULL,            -- path-derived slug, e.g., 'ai/token-counter'
    name        TEXT NOT NULL,            -- from manifest.name (often the leaf segment of id)
    version     TEXT,
    description TEXT,
    topic       TEXT,
    tags        TEXT[] NOT NULL DEFAULT '{}',
    runtime     TEXT,
    manifest    JSONB NOT NULL,           -- full skillzkit manifest.yaml as JSON
    source      TEXT NOT NULL DEFAULT 'skillzkit'
                CHECK (source IN ('skillzkit', 'user-authored')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at  TIMESTAMPTZ,
    PRIMARY KEY (org_id, type, id)
);

CREATE INDEX IF NOT EXISTS idx_catalog_items_type
    ON catalog_items (org_id, type)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_catalog_items_topic
    ON catalog_items (org_id, type, topic)
    WHERE deleted_at IS NULL AND topic IS NOT NULL;

-- GIN index for tag-set queries (e.g., "all skills tagged 'ai'").
CREATE INDEX IF NOT EXISTS idx_catalog_items_tags
    ON catalog_items USING GIN (tags)
    WHERE deleted_at IS NULL;

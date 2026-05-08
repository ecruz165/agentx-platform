-- Catalog module: agents table.
-- Mirrors the TS-side AgentDef wire contract from harness-core/src/catalog.ts:
--   { id, role, adapter, systemPrompt?, config?, accepts?, fallbackOn?, skillz? }
--
-- Multi-tenant: PRIMARY KEY (org_id, id). Soft-delete via deleted_at.
-- adapter has a CHECK constraint for the v1 known values; new adapters
-- (e.g. future 'goose-cli') are added by extending this list.
-- All idempotent — safe to re-apply.

CREATE TABLE IF NOT EXISTS agents (
    org_id        TEXT NOT NULL REFERENCES tenants(org_id) ON DELETE CASCADE,
    id            TEXT NOT NULL,
    role          TEXT NOT NULL,
    adapter       TEXT NOT NULL
                  CHECK (adapter IN ('claude-sdk', 'opencode-cli')),
    system_prompt TEXT,
    config        JSONB,
    accepts       JSONB,
    fallback_on   JSONB,
    skillz        JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by    TEXT,
    updated_by    TEXT,
    deleted_at    TIMESTAMPTZ,
    PRIMARY KEY (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agents_org_adapter
    ON agents (org_id, adapter)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agents_org_updated_at
    ON agents (org_id, updated_at DESC)
    WHERE deleted_at IS NULL;

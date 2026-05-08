-- Catalog module: products table.
-- Mirrors TS-side ProductDef from harness-core/src/catalog.ts:
--   { id, description?, contextSources?, repos? }
--
-- contextSources + repos stored as JSONB arrays (lists of typed objects).
-- Idempotent — safe to re-apply.

CREATE TABLE IF NOT EXISTS products (
    org_id          TEXT NOT NULL REFERENCES tenants(org_id) ON DELETE CASCADE,
    id              TEXT NOT NULL,
    description     TEXT,
    context_sources JSONB,  -- array of ContextSourceDef
    repos           JSONB,  -- array of ProductRepo
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by      TEXT,
    updated_by      TEXT,
    deleted_at      TIMESTAMPTZ,
    PRIMARY KEY (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_products_org_updated_at
    ON products (org_id, updated_at DESC)
    WHERE deleted_at IS NULL;

-- V0015 — story-point estimation, post-job reflection, + proposed-skill
-- governance.
--
-- Estimation/reflection lives on jobs:
--   estimated_points  set on submission via JobIntent.config.estimatedPoints
--   actual_points     set on POST /api/jobs/{id}/reflection
--   reflection        narrative ("here's what surprised me, here's
--                     what I'd do differently")
--   surprises         JSONB array of structured surprise items
--                     (optional; reflection text is the lighter-weight
--                     path)
--   reflected_at      when the reflection was posted
--
-- Proposed skills get their own table with a governance lifecycle:
--   proposed → approved (creates a draft catalog_items row) | rejected
-- An admin reviews each one in /proposals before it lands in the
-- catalog. Future iteration: PR-bot pushes approved proposals back
-- to the @ecruz165/skillzkit repo as actual PRs.
--
-- Idempotent.

ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS estimated_points  NUMERIC,
    ADD COLUMN IF NOT EXISTS actual_points     NUMERIC,
    ADD COLUMN IF NOT EXISTS reflection        TEXT,
    ADD COLUMN IF NOT EXISTS surprises         JSONB,
    ADD COLUMN IF NOT EXISTS reflected_at      TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS skill_proposals (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            TEXT NOT NULL REFERENCES tenants(org_id) ON DELETE CASCADE,
    source_job_id     TEXT,
    name              TEXT NOT NULL,
    description       TEXT,
    rationale         TEXT,
    category          TEXT,         -- 'tool' | 'integration' | 'task' | 'workflow' | …
    tags              TEXT[] NOT NULL DEFAULT '{}',
    status            TEXT NOT NULL DEFAULT 'proposed'
                      CHECK (status IN ('proposed', 'approved', 'rejected')),
    reviewer          TEXT,
    reviewed_at       TIMESTAMPTZ,
    rejection_reason  TEXT,
    catalog_item_id   TEXT,         -- after approval, the catalog_items row id
    created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_skill_proposals_org_status
    ON skill_proposals (org_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_skill_proposals_source_job
    ON skill_proposals (source_job_id)
    WHERE source_job_id IS NOT NULL;

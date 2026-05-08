-- V0013 — eval test-suite fixtures.
--
-- A suite is a named bag of inputs against which a benchmark run
-- submits one job per input. Same fixture × different configs =
-- side-by-side comparison.
--
--   POST /api/evals/suites                            create / upsert
--   POST /api/evals/suites/{id}/run                   submit N jobs tagged
--                                                     with one benchmark_run_id
--   GET  /api/benchmarks/compare?runIds=A,B           compare from V0012
--
-- inputs is a JSONB array; each element is one job's input. The
-- service derives N submissions from this array — one per element.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS eval_suites (
    org_id      TEXT NOT NULL REFERENCES tenants(org_id) ON DELETE CASCADE,
    id          TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    inputs      JSONB NOT NULL DEFAULT '[]'::jsonb
                CHECK (jsonb_typeof(inputs) = 'array'),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by  TEXT,
    deleted_at  TIMESTAMPTZ,
    PRIMARY KEY (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_eval_suites_org
    ON eval_suites (org_id, created_at DESC)
    WHERE deleted_at IS NULL;

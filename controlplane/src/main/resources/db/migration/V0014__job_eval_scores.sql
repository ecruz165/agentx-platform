-- V0014 — quality scoring per job result.
--
-- An external scorer (rubric runner, LLM-as-judge script, manual review,
-- or a future controlplane-internal evaluator) posts a score per
-- completed job via POST /api/jobs/{id}/score. Scores are 0..1 doubles;
-- rationale is freeform text; judge identifies the scorer kind.
--
-- The compare endpoint aggregates avg + p50 + p95 score per benchmark
-- run for side-by-side display.
--
-- Idempotent.

ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS eval_score      NUMERIC(5,4)
                              CHECK (eval_score IS NULL
                                  OR (eval_score >= 0 AND eval_score <= 1)),
    ADD COLUMN IF NOT EXISTS eval_rationale  TEXT,
    ADD COLUMN IF NOT EXISTS eval_judge      TEXT,         -- 'rubric' | 'llm-judge' | 'manual' | …
    ADD COLUMN IF NOT EXISTS eval_scored_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_jobs_benchmark_score
    ON jobs (org_id, benchmark_run_id, eval_score)
    WHERE benchmark_run_id IS NOT NULL AND eval_score IS NOT NULL;

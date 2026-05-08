-- V0012 — benchmark run tagging on jobs.
--
-- Lets a single benchmark run group N job submissions for compare:
--   workspace bench --suite my-tests --pipeline X --label "qwen-0.6b run-1"
--   workspace bench --suite my-tests --pipeline X --label "qwen-4b  run-1"
-- Both runs submit jobs against the same pipeline + inputs but with
-- different model configs; benchmark_run_id correlates the cohort.
--
-- The label is human-readable ("qwen-0.6b vs qwen-4b"); run_id is the
-- machine-correlation key. Tagging is opt-in — non-benchmark jobs
-- leave both columns NULL.
--
-- Idempotent.

ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS benchmark_run_id TEXT,
    ADD COLUMN IF NOT EXISTS benchmark_label  TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_benchmark_run
    ON jobs (org_id, benchmark_run_id)
    WHERE benchmark_run_id IS NOT NULL;

-- V0017 — record which harness-server a WORK job was dispatched to (W1).
--
-- Set by JobService.submit when the resolved flow's kind is WORK: the job
-- is persisted QUEUED, then forwarded to a registered harness-server
-- (HarnessForwardingService) which executes the whole flow graph in
-- harness-core. JOB_DEFINITION / POST_JOB flows leave this NULL — they
-- run in the in-process JobEngine.
--
-- Idempotent per project convention (re-applies cleanly during dev).

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS dispatched_to_harness_id TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_dispatched_harness
    ON jobs (dispatched_to_harness_id)
    WHERE dispatched_to_harness_id IS NOT NULL;

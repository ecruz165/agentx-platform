-- V0011 — track per-harness in-flight jobs reported via heartbeat.
--
-- The harness-server queries its own /v1/dispatcher/status endpoint
-- and forwards the snapshot in each heartbeat. The controlplane stores
-- it on the harness row as JSONB; admins can see "harness X has these
-- jobs running" without per-job RPC.
--
-- Snapshot shape (matches harness-server's DispatcherState.statusSnapshot):
--   {
--     "capacity": 4,
--     "inFlight": ["job-abc", "job-def"],
--     "queued": [{ "jobId": "job-xyz", "enqueuedAt": ..., "waitingMs": ... }]
--   }
--
-- Idempotent (per feedback_idempotent_migrations).

ALTER TABLE harnesses
    ADD COLUMN IF NOT EXISTS current_jobs JSONB;

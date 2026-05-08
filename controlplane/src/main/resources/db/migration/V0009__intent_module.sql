-- V0009 — Intent module
-- Conversational intake sessions. Each session pairs a user with an
-- intake JobDefinitionPipeline (flowId in catalog) and tracks the
-- transition to a confirmed work job. Conversation content is NOT
-- duplicated here — it lives in the underlying intake job's event log
-- (per prd-intent-module.md F20, D2).
--
-- Idempotent (per feedback_idempotent_migrations memory): IF NOT EXISTS
-- on every object so partial re-applies during dev are safe until v1.

CREATE TABLE IF NOT EXISTS intent_sessions (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               text        NOT NULL,
    user_id              text        NOT NULL,
    intake_pipeline_id   text        NOT NULL,
    intake_job_id        text,
    work_job_id          text,
    -- 'awaiting-message' | 'processing' | 'intent-ready' | 'submitted' | 'expired' | 'aborted' | 'failed'
    status               text        NOT NULL,
    resolved_intent      jsonb,
    failure_reason       text,
    created_at           timestamptz NOT NULL DEFAULT NOW(),
    last_activity_at     timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_intent_sessions_org
    ON intent_sessions (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_intent_sessions_intake_job
    ON intent_sessions (intake_job_id) WHERE intake_job_id IS NOT NULL;

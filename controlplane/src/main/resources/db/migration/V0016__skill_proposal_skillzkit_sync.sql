-- Tracks skill_proposals' lifecycle in upstream skillzkit (the
-- source of truth for skills). Per memory `project_skillzkit_is_skill_source_of_truth`,
-- approved proposals must round-trip back to skillzkit; this slice
-- POSTs to skillzkit's /api/v1/contributions endpoint and stores the
-- returned contribution id + status here so the proposals admin UI
-- can show submission state and operators can retry failed sends.
--
-- Idempotent per `feedback_idempotent_migrations` — every column add
-- guarded with IF NOT EXISTS so re-applying during dev is safe.

ALTER TABLE skill_proposals
    ADD COLUMN IF NOT EXISTS remote_id          TEXT,
    ADD COLUMN IF NOT EXISTS remote_status      TEXT,
    ADD COLUMN IF NOT EXISTS remote_url         TEXT,
    ADD COLUMN IF NOT EXISTS remote_error       TEXT,
    ADD COLUMN IF NOT EXISTS remote_synced_at   TIMESTAMPTZ;

-- Allowed values mirror skillzkit's ContributionStatus union plus a
-- local-only `failed` for transport / 5xx errors that didn't land a
-- contribution row remotely. `null` means we haven't tried (proposal
-- approved before skillzkit integration was wired, or skillzkit is
-- intentionally not configured).
ALTER TABLE skill_proposals
    DROP CONSTRAINT IF EXISTS skill_proposals_remote_status_check;
ALTER TABLE skill_proposals
    ADD CONSTRAINT skill_proposals_remote_status_check
    CHECK (
        remote_status IS NULL
        OR remote_status IN (
            'pending',
            'reviewing',
            'accepted',
            'rejected',
            'promoted',
            'failed'
        )
    );

-- Status-poller index: walks proposals whose remote state is non-
-- terminal (pending or reviewing) and refreshes from skillzkit.
-- Partial index so it stays small as the proposals table grows;
-- accepted/rejected/promoted/failed/null rows aren't candidates.
CREATE INDEX IF NOT EXISTS skill_proposals_remote_in_flight_idx
    ON skill_proposals (remote_synced_at)
    WHERE remote_status IN ('pending', 'reviewing');

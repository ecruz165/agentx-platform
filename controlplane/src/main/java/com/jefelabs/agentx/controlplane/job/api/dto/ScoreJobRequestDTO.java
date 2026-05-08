package com.jefelabs.agentx.controlplane.job.api.dto;

/**
 * Wire format for {@code POST /api/jobs/{id}/score}. Posted by an
 * external scorer (rubric runner / LLM-as-judge / manual review) once
 * a job's output is available.
 *
 * <p>{@code score} is in [0, 1] (the schema CHECK enforces this).
 * {@code rationale} explains the score for human review.
 * {@code judge} identifies the scorer kind so the compare endpoint
 * can later surface "% scored by LLM judge vs rubric vs manual."
 */
public record ScoreJobRequestDTO(
    Double score,
    String rationale,
    String judge
) {
}

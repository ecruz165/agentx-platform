package com.jefelabs.agentx.controlplane.job.domain;

import tools.jackson.databind.JsonNode;

import java.time.Instant;

/**
 * Domain type for an in-flight job. Persisted in the {@code jobs} table.
 *
 * <p>{@code currentNodeId} tracks where the engine is in the FlowDef (the
 * id of the FlowDef node currently running, or null if not yet started or
 * past the last node). Engine logic (Phase 3b) updates it as the walk
 * progresses.
 */
public record Job(
    String orgId,
    String id,
    String flowId,
    String productId,
    JobStatus status,
    JsonNode input,
    String setName,
    JsonNode config,
    JsonNode output,
    String failureReason,
    String currentNodeId,
    /** Benchmark cohort id; null for regular submissions. Set when a job
     *  is submitted as part of a {@code workspace bench} run so all the
     *  variants of a comparison can be aggregated together. */
    String benchmarkRunId,
    /** Human-readable label for the benchmark variant, e.g.
     *  {@code "qwen-0.6b run-1"}. Null when not benchmarking. */
    String benchmarkLabel,
    /** Quality score in [0, 1] posted by an external scorer
     *  (rubric runner / LLM-as-judge / manual). Null until scored. */
    Double evalScore,
    /** Human-readable explanation of the score (the rubric line that
     *  failed, the judge's reasoning, the reviewer's note). */
    String evalRationale,
    /** What kind of scorer produced this — e.g. {@code "rubric"},
     *  {@code "llm-judge"}, {@code "manual"}. */
    String evalJudge,
    Instant evalScoredAt,
    Instant createdAt,
    Instant startedAt,
    Instant completedAt,
    String createdBy
) {
}

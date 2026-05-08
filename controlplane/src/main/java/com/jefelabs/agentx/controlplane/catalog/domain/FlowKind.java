package com.jefelabs.agentx.controlplane.catalog.domain;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * The flow's role in the platform — discriminator from TS-side
 * {@code FlowDef.kind} in {@code harness-core/src/catalog.ts}.
 *
 * <p>Wire format uses lowercase-hyphenated names (e.g., {@code job-definition})
 * to match the TS contract; Java identifiers are conventional UPPER_SNAKE.
 */
public enum FlowKind {
    /** Default: agents run for end-user value. */
    @JsonProperty("work")
    WORK,

    /** Conversational intake; emits a {@code JobIntent}. Must declare {@code output: {kind: 'job-intent'}}. */
    @JsonProperty("job-definition")
    JOB_DEFINITION,

    /** Post-completion cleanup or notifications. */
    @JsonProperty("post-job")
    POST_JOB;

    /** Database storage uses the same hyphenated representation. */
    public String dbValue() {
        return switch (this) {
            case WORK -> "work";
            case JOB_DEFINITION -> "job-definition";
            case POST_JOB -> "post-job";
        };
    }

    public static FlowKind fromDbValue(String value) {
        return switch (value) {
            case "work" -> WORK;
            case "job-definition" -> JOB_DEFINITION;
            case "post-job" -> POST_JOB;
            default -> throw new IllegalArgumentException("Unknown FlowKind dbValue: " + value);
        };
    }
}

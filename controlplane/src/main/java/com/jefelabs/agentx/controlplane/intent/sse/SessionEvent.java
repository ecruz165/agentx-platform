package com.jefelabs.agentx.controlplane.intent.sse;

import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.UUID;

/**
 * Phase 5.4 — concrete event types streamed over SSE for an intake session.
 * Sealed so the bus can exhaustively dispatch by kind. Each record carries
 * the {@code sessionId}, an {@code at} timestamp, and an optional payload.
 *
 * <p>Wire format follows the SSE convention: each event is serialized as
 * JSON and the SSE {@code event} field carries the discriminator
 * (e.g., {@code intent-ready}). Per prd-intent-module.md F5.
 */
public sealed interface SessionEvent {
    UUID sessionId();
    Instant at();
    /** Wire-side discriminator (matches the SSE event name). */
    String kind();

    record SessionStarted(UUID sessionId, Instant at, String intakeJobId) implements SessionEvent {
        @Override public String kind() { return "session-started"; }
    }
    record IntentReady(UUID sessionId, Instant at, JsonNode resolvedIntent) implements SessionEvent {
        @Override public String kind() { return "intent-ready"; }
    }
    record PipelineCreationRequired(UUID sessionId, Instant at, JsonNode pipelineSpec) implements SessionEvent {
        @Override public String kind() { return "pipeline-creation-required"; }
    }
    record PipelineCreated(UUID sessionId, Instant at, String pipelineId) implements SessionEvent {
        @Override public String kind() { return "pipeline-created"; }
    }
    record JobSubmitted(UUID sessionId, Instant at, String workJobId) implements SessionEvent {
        @Override public String kind() { return "job-submitted"; }
    }
    record Aborted(UUID sessionId, Instant at) implements SessionEvent {
        @Override public String kind() { return "aborted"; }
    }
    record Error(UUID sessionId, Instant at, String message) implements SessionEvent {
        @Override public String kind() { return "error"; }
    }
}

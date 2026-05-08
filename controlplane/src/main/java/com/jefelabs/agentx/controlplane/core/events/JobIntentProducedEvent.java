package com.jefelabs.agentx.controlplane.core.events;

import tools.jackson.databind.JsonNode;

/**
 * Published by the Job module when a {@code kind: 'job-definition'} flow
 * completes successfully. Carries the resolved JobIntent (the flow's
 * output) so listeners (currently only the Intent module) can react
 * without re-fetching the job's output column.
 *
 * <p>Per prd-intent-module.md F10: IntentService listens for this event,
 * validates the intent, and transitions the corresponding session to
 * {@code intent-ready}.
 *
 * <p>{@code intent} is the raw output JsonNode (expected to follow
 * {@code core.types.JobIntent} field shape). Listeners should defensively
 * read the node — flows authored with {@code kind: 'job-definition'} but
 * whose output drifts from the JobIntent shape will surface validation
 * errors at the listener.
 */
public record JobIntentProducedEvent(
    String orgId,
    String jobId,
    String flowId,
    JsonNode intent
) {
}

/**
 * Intent module — conversational intake surface that produces {@code JobIntent} values.
 *
 * <p>Closed module. Submits {@code kind: 'job-definition'} pipelines to the Job module
 * via Spring DI; consumes {@code JobIntentProducedEvent}s from JSM; emits its own session
 * lifecycle events for the Web UI's chat surface.
 *
 * <p>See {@code .plans/2026-05-07-prd-intent-module.md}.
 */
@org.springframework.modulith.ApplicationModule(
    displayName = "Intent"
)
package com.jefelabs.agentx.controlplane.intent;

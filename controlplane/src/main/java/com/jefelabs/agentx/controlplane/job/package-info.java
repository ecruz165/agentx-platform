/**
 * Job module — in-flight jobs, JobStateMachine, durable event log.
 *
 * <p>Closed module. The canonical {@code JobIntent → Job} boundary
 * ({@code JobStateMachine.submit(JobIntent) → Job}). Owns the RPC channel to harnesses
 * for step execution + steer + file routes; emits {@code StepReady} events consumed by
 * Dispatch.
 *
 * <p>See {@code .plans/2026-05-07-prd-job-module.md}.
 */
@org.springframework.modulith.ApplicationModule(
    displayName = "Job"
)
package com.jefelabs.agentx.controlplane.job;

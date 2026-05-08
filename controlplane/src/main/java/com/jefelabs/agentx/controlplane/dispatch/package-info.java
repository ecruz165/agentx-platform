/**
 * Dispatch module — routing policy + dispatch queue + decision audit.
 *
 * <p>Closed module. The saga between Job (work to do) and Harness (workers available).
 * Reads from Harness module's view of healthy harnesses; writes its own
 * {@code dispatch_queue} and {@code routing_decisions} tables; emits
 * {@code DispatchReady} events that the Job module consumes to RPC the assigned harness.
 *
 * <p>See {@code .plans/2026-05-07-prd-dispatch-module.md}.
 */
@org.springframework.modulith.ApplicationModule(
    displayName = "Dispatch"
)
package com.jefelabs.agentx.controlplane.dispatch;

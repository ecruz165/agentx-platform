/**
 * Harness module — service discovery layer for harness-server instances.
 *
 * <p>Closed module. Owns harness registration, heartbeat tracking, capability declarations,
 * and the connection broker that the Job module uses to RPC harnesses for step execution.
 * Auth (API token / mTLS) wired in Phase 7 per
 * {@code prd-control-plane-operational-hardening.md}.
 *
 * <p>See {@code .plans/2026-05-07-prd-harness-module.md}.
 */
@org.springframework.modulith.ApplicationModule(
    displayName = "Harness"
)
package com.jefelabs.agentx.controlplane.harness;

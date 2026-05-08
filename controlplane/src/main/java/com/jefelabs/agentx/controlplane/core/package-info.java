/**
 * Core module — scaffolding + shared kernel for the control plane.
 *
 * <p>Open module: every closed domain module may import core's public types without
 * declaring an explicit dependency. Owns: {@code TenantContext}, {@code OrgId},
 * {@code ProductId}, {@code JobIntent}, base {@code AuditableEntity}, common event
 * envelopes, and Spring scaffolding (security config, persistence, OpenAPI).
 *
 * <p>See {@code .plans/2026-05-07-prd-core-module.md}.
 */
@org.springframework.modulith.ApplicationModule(
    type = org.springframework.modulith.ApplicationModule.Type.OPEN,
    displayName = "Core (shared kernel + scaffolding)"
)
package com.jefelabs.agentx.controlplane.core;

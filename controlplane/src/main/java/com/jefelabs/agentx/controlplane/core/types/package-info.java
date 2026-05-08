/**
 * Shared kernel types — exported from {@code core} (an open module) so
 * every domain module can reference them without declaring a peer
 * dependency. Currently houses {@link JobIntent}; future cross-cutting
 * value types ({@code OrgId}, {@code ProductId}, {@code EventEnvelope})
 * arrive here in Phase 7 per {@code prd-core-module.md} §6.6.
 */
@org.springframework.modulith.NamedInterface("types")
package com.jefelabs.agentx.controlplane.core.types;

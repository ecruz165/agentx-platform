/**
 * Catalog module service layer. Exposed as a named interface so other
 * modules (currently {@code job}'s engine, eventually {@code intent})
 * can read FlowDefs + Agents during execution. Spring Modulith default
 * rules treat sub-packages as CLOSED; {@code @NamedInterface} is the
 * sanctioned escape hatch.
 */
@org.springframework.modulith.NamedInterface("services")
package com.jefelabs.agentx.controlplane.catalog.service;

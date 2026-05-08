/**
 * Job module service layer. Exposed as a named interface so other
 * modules (currently {@code intent} for chat-driven submission) can
 * call {@code JobService.submit} / {@code deliverEvent} without
 * importing engine internals. Spring Modulith default rules treat
 * sub-packages as CLOSED; {@code @NamedInterface} is the sanctioned
 * escape hatch.
 */
@org.springframework.modulith.NamedInterface("services")
package com.jefelabs.agentx.controlplane.job.service;

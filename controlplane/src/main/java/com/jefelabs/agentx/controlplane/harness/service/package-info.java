/**
 * Harness module service layer. Exposed as a named interface so the Dispatch
 * module can read registry state when routing steps. Per Spring Modulith
 * default rules, sub-packages are CLOSED; {@code @NamedInterface} is the
 * sanctioned escape hatch when another module legitimately needs to call in.
 */
@org.springframework.modulith.NamedInterface("services")
package com.jefelabs.agentx.controlplane.harness.service;

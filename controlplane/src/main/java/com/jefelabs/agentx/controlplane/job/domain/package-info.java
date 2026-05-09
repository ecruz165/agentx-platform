/**
 * Job module domain types. Exposed as a named interface so cross-
 * module callers ({@code intent}, {@code eval}) can reference Job
 * directly when wiring lifecycle hooks. Spring Modulith default
 * rules treat sub-packages as CLOSED; {@code @NamedInterface} is the
 * sanctioned escape hatch.
 *
 * <p>Domain types are deliberately exposed (not just service APIs)
 * because the cross-module use cases — IntentService linking a
 * session to its work-job; eval suites projecting Job into a row —
 * legitimately need the typed shape, not just a pass-through method
 * call. Treating Job as opaque would force every consumer to call
 * back into job.service, which is its own kind of coupling.
 */
@org.springframework.modulith.NamedInterface("types")
package com.jefelabs.agentx.controlplane.job.domain;

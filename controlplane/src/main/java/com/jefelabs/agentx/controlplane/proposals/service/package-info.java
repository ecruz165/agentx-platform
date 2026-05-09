/**
 * Proposals module service layer. Exposed as a named interface so the
 * {@code job} module's controller can call
 * {@link com.jefelabs.agentx.controlplane.proposals.service.SkillProposalService#createFromSurprises}
 * when a job records its post-run reflection. Spring Modulith default
 * rules treat sub-packages as CLOSED; {@code @NamedInterface} is the
 * sanctioned escape hatch.
 */
@org.springframework.modulith.NamedInterface("services")
package com.jefelabs.agentx.controlplane.proposals.service;

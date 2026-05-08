/**
 * Dispatch module service layer. Exposed as a named interface so the Job
 * engine's AgentStepHandler can call HarnessRouter.routeStep(...) to
 * resolve a harness per step.
 */
@org.springframework.modulith.NamedInterface("services")
package com.jefelabs.agentx.controlplane.dispatch.service;

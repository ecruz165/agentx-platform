/**
 * Cross-module Spring Modulith events. Exposed as a named interface so
 * any module can publish or listen — events are the canonical sanctioned
 * cross-module data flow under Modulith's CLOSED-by-default rules.
 *
 * <p>Events are persisted via the JDBC eventing variant (configured at the
 * application level); listeners are wired with
 * {@code @org.springframework.modulith.events.ApplicationModuleListener}
 * and run synchronously after the publishing transaction commits.
 */
@org.springframework.modulith.NamedInterface("events")
package com.jefelabs.agentx.controlplane.core.events;
